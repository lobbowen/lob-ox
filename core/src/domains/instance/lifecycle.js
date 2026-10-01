'use strict';
const fs = require('node:fs');
const monitor = require('../../platform/service/monitor');
const ports = require('../../platform/service/ports').shared;
const guardian = require('../../shared/guardian');
const sandbox = require('./sandbox');
const governor = require('./governor');
const stateMachine = require('./state-machine');
const execPath = require('../../platform/os/exec-path');
function createLifecycle(deps) {
  const { store, service, logger, events, tokens, tasks, systemdDir, systemdTemplatePath, hooks, instancesRoot, resstats, machineFacts } = deps;
  const isSandboxSupported = deps.isSandboxSupported;
  const stateDeps = () => ({ events, logger, save: () => store.save(), tokens });
  const runtime = new Map();
  const machineFactsNow = () => (typeof machineFacts === 'function' ? machineFacts() : governor.machineFacts());
  function _prepareSystemd() {
    if (!service.supportsUnits) return true;
    try {
      fs.mkdirSync(systemdDir, { recursive: true });
      if (fs.existsSync(systemdTemplatePath)) {
        const stamp = Date.now();
        let aside = systemdTemplatePath + '.disabled-by-dsh-' + stamp;
        let n = 1;
        while (fs.existsSync(aside)) { aside = systemdTemplatePath + '.disabled-by-dsh-' + stamp + '-' + (n++); }
        fs.renameSync(systemdTemplatePath, aside);
        logger.info && logger.info('已将阻挡 systemd-run 的模板让位（改名保留，未删除）：' + aside);
        if (events) events.append('systemd_template_moved_aside', { from: systemdTemplatePath, to: aside });
      }
      const reloaded = service.daemonReload();
      if (reloaded === false) logger.warn && logger.warn('systemd daemon-reload 失败（不阻断实例创建）');
      return true;
    } catch (e) {
      logger.error && logger.error('_prepareSystemd: ' + e.message);
      return false;
    }
  }
  function _cleanStaleUnit(unit, ctx) {
    const r = service.cleanTransient(unit, ctx);
    if (r && r.ok === false) {
      logger.warn && logger.warn('clean stale transient unit 未完全生效: ' + unit +
        (r.errors && r.errors.length ? ' errors=' + r.errors.join(';') : ''));
    } else {
      logger.info && logger.info('cleaned stale transient unit: ' + unit);
    }
  }
  function _systemdStart(inst, opts) {
    try {
      const cmdArr = sandbox.effectiveCommand(instancesRoot, deps.dshBin, inst);
      if (!cmdArr || !cmdArr.length) return { ok: false, error: '实例未配置启动命令' };
      const boundary = inst.domain === 'sandbox'
        ? execPath.commandEntryViolation(cmdArr, {
            roots: [sandbox.installDir(instancesRoot, inst)],
            files: execPath.knownDshEntries({ dshBin: deps.dshBin }),
          })
        : null;
      if (boundary) {
        const msg = '启动命令未通过执行边界复校：' + boundary;
        inst.state.lastError = msg;
        store.save();
        if (events) events.append('inst_start_refused', { id: inst.id, name: inst.name, error: msg });
        logger.warn && logger.warn('[' + inst.id + '] ' + msg);
        return { ok: false, error: msg };
      }
      // 端口预校验：注册表是跨进程共享事实，配置端口被他人登记即显式 PORT_TAKEN（TCP 探测看不见「已登记未监听」）。
      const takenBy = ports.recordOf(inst.port);
      if (takenBy && takenBy.owner !== 'inst:' + inst.id) {
        const msg = 'PORT_TAKEN:' + (takenBy.owner || takenBy.role);
        inst.state.lastError = msg;
        store.save();
        if (events) events.append('inst_start_refused', { id: inst.id, name: inst.name, error: msg });
        logger.warn && logger.warn('[' + inst.id + '] ' + msg);
        return { ok: false, error: msg };
      }
      if (probe(inst).running) return { ok: false, error: '端口 ' + inst.port + ' 已被占用' };
      const alloc = governor.currentAllocation(store.instances, inst.id, machineFactsNow());
      inst.state.allocation = alloc;
      const props = sandbox.unitProps(inst, alloc);
      const { env, workingDir } = sandbox.sandboxEnv(instancesRoot, inst);
      const ctx = sandbox.launchCtx(instancesRoot, deps.dshBin, inst);
      _cleanStaleUnit('dsh-web@' + inst.id, ctx);
      try {
        service.startTransient({ unit: 'dsh-web@' + inst.id, cmd: cmdArr, env, props, workingDir, port: ctx.port, pidFile: ctx.pidFile, anchors: ctx.anchors });
      } catch (e) {
        const msg = 'systemd 启动失败: ' + (e.message || e);
        inst.state.lastError = msg;
        store.save();
        if (events) events.append('inst_start_failed', { id: inst.id, name: inst.name, error: msg });
        return { ok: false, error: msg };
      }
      inst.state.phase = 'STARTING';
      inst.state.startAt = Date.now();
      inst.state.lastError = null;
      if (opts && opts.manual) {
        inst.state.restartCount = 0;
        inst.state.backoffLevel = 0;
        inst.state.backoffUntil = null;
        inst.state.lastFailAt = null;
      }
      store.save();
      if (inst.port && hooks.onInstanceStart) hooks.onInstanceStart(inst);
      if (events) events.append('inst_started', { id: inst.id, port: inst.port });
      logger.info && logger.info('started instance ' + inst.name + ' (dsh-web@' + inst.id + ')');
      return { ok: true };
    } catch (e) {
      logger.error && logger.error('_systemdStart error ' + inst.id + ': ' + e.message);
      return { ok: false, error: e.message };
    }
  }
  async function start(id, opts) {
    const inst = store.instances.find((i) => i.id === id);
    if (!inst) return { ok: false, error: '实例不存在' };
    if (!isSandboxSupported()) return { ok: false, error: '当前平台不支持沙箱实例（能力矩阵见 GET /env/status 的 capabilities.sandboxLaunch；限额执行档位见 capabilities.sandboxEnforcement）' };
    _prepareSystemd();
    if (inst.domain === 'sandbox') {
      const fromUpgrade = !!(opts && opts.fromUpgrade);
      if (!fromUpgrade && tasks && tasks.isBusy('instance', id)) return { ok: true, installing: true, already: true };
      if (!fromUpgrade) {
        const adm = governor.admission(store.instances, inst.id, machineFactsNow().totalMemBytes);
        if (!adm.ok) {
          logger.warn && logger.warn('[' + inst.id + '] ' + adm.error);
          return { ok: false, error: adm.error };
        }
      }
      store.ensureDirs(inst);
      const dshEntry = sandbox.dshEntry(instancesRoot, inst);
      if (!fs.existsSync(dshEntry)) {
        const r = await deps.install(inst);
        if (!r.ok) return { ok: false, error: '沙箱实例安装 DSH 失败: ' + (r.error || 'unknown') };
        return { ok: true, installing: true };
      }
    }
    return _systemdStart(inst, opts);
  }
  function stop(id) {
    const inst = store.instances.find((i) => i.id === id);
    if (!inst) return { ok: false, error: '实例不存在' };
    if (!isSandboxSupported()) return { ok: false, error: '当前平台不支持沙箱实例（能力矩阵见 GET /env/status 的 capabilities.sandboxLaunch；限额执行档位见 capabilities.sandboxEnforcement）' };
    const unit = 'dsh-web@' + inst.id;
    let stopped;
    try { stopped = service.stopUnit(unit, Object.assign({ timeoutMs: 20000 }, sandbox.launchCtx(instancesRoot, deps.dshBin, inst))); }
    catch (e) { stopped = false; logger.warn && logger.warn('[' + inst.id + '] 停止单元 ' + unit + ' 异常: ' + (e && e.message)); }
    if (stopped === false) {
      const msg = '停止实例失败（单元 ' + unit + ' 未确认停止）';
      inst.state.lastError = msg;
      store.save();
      if (events) events.append('inst_stop_failed', { id: inst.id, name: inst.name, error: msg });
      logger.warn && logger.warn('[' + inst.id + '] ' + msg);
      return { ok: false, error: msg };
    }
    inst.state.phase = 'STOPPED';
    inst.state.usage = null;
    runtime.delete(inst.id);
    store.save();
    if (inst.port && hooks.onInstanceStop) hooks.onInstanceStop(inst);
    if (events) events.append('inst_stopped', { id: inst.id });
    return { ok: true };
  }
  function probe(inst) { return monitor.probeInstance(inst); }
  function probeInstance(id) {
    const inst = store.instances.find((i) => i.id === id);
    if (!inst) return { pid: null, running: false, isDsh: false, phase: 'STOPPED' };
    return probe(inst);
  }
  function _sandboxRoster() {
    const roster = [];
    for (const i of store.instances) {
      if (i.domain !== 'sandbox' || !i.state || i.state.phase !== 'RUNNING') continue;
      const rec = runtime.get(i.id) || {};
      roster.push({
        id: i.id,
        usageMb: typeof rec.rssMb === 'number' ? rec.rssMb : null,
        cpuPct: typeof rec.cpuPct === 'number' ? rec.cpuPct : null,
        since: i.state.startAt || 0,
        prevAlloc: i.state.allocation || null,
        prevTicks: { mem: rec.memTicks || 0, cpu: rec.cpuTicks || 0 },
      });
    }
    return roster;
  }
  function _governTick(inst, st) {
    for (const key of Array.from(runtime.keys())) {
      if (!store.instances.some((i) => i.id === key)) runtime.delete(key);
    }
    if (resstats && st.pid) {
      Promise.resolve(resstats.sampleAsync(st.pid)).then((s) => {
        if (!s) return;
        const prev = runtime.get(inst.id) || {};
        const t = Date.now();
        let cpuPct = null;
        if (prev.last && t > prev.last.t) {
          const dw = t - prev.last.t;
          const dc = s.cpuMs - prev.last.cpuMs;
          if (dw > 0 && dc >= 0) cpuPct = Math.round((dc / dw) * 1000) / 10;
        }
        runtime.set(inst.id, {
          last: { t, cpuMs: s.cpuMs },
          rssMb: Math.round((s.rssBytes / (1024 * 1024)) * 10) / 10,
          cpuPct,
          memTicks: prev.memTicks || 0,
          cpuTicks: prev.cpuTicks || 0,
        });
      }).catch(() => {});
    }
  }

  function governSweep() {
    const roster = _sandboxRoster();
    if (!roster.length) return { ok: true, entries: 0 };
    let plan;
    try {
      const f = machineFactsNow();
      plan = governor.decide({ totalMemBytes: f.totalMemBytes, cpuCount: f.cpuCount, roster });
    } catch (e) {
      logger.warn && logger.warn('govern decide 失败: ' + (e && e.message));
      return { ok: false, error: (e && e.message) || String(e) };
    }
    const now = Date.now();
    for (const entry of plan.entries) {
      const target = store.instances.find((i) => i.id === entry.id);
      if (!target) continue;
      const rec = runtime.get(entry.id) || {};
      rec.memTicks = entry.ticks.mem;
      rec.cpuTicks = entry.ticks.cpu;
      runtime.set(entry.id, rec);
      target.state.usage = {
        memMb: typeof rec.rssMb === 'number' ? rec.rssMb : null,
        cpuPct: typeof rec.cpuPct === 'number' ? rec.cpuPct : null,
        at: now,
      };
      if (entry.changed) {
        target.state.allocation = entry.alloc;
        if (typeof service.setLimits === 'function' && target.state && target.state.phase === 'RUNNING') {
          try { service.setLimits('dsh-web@' + entry.id, entry.alloc); }
          catch (e) { logger.warn && logger.warn('[' + entry.id + '] setLimits 下发异常: ' + (e && e.message)); }
        }
      }
      if (!entry.violation) continue;
      const v = entry.violation;
      const kindLabel = v.kind === 'memory' ? '内存' : 'CPU';
      const reason = '资源违规:' + kindLabel + '持续超限(实际 ' + v.actual + '/限额 ' + v.target + ')';
      if (events) events.append('inst_resource_violation', { id: target.id, name: target.name, kind: v.kind, actual: v.actual, target: v.target });
      logger.warn && logger.warn('[' + target.id + '] ' + reason);
      try {
        service.stopUnit('dsh-web@' + target.id, Object.assign({ timeoutMs: 20000 }, sandbox.launchCtx(instancesRoot, deps.dshBin, target)));
      } catch (e) {
        logger.warn && logger.warn('[' + target.id + '] 违规停单元异常: ' + (e && e.message));
      }
      stateMachine.restart(stateDeps(), target, reason);
    }
    store.save();
    return { ok: true, entries: plan.entries.length };
  }
  function supervise(id) {
    const inst = store.instances.find((i) => i.id === id);
    if (!inst || inst.domain === 'native') return { ok: true, skipped: !inst ? 'not-found' : 'native' };
    const now = Date.now();
    try {
      const st = probe(inst);
      if (inst.domain === 'sandbox' && tokens) { try { tokens.ensureCaptured(inst.id); } catch {} }
      const state = inst.state;
      const guarded = guardian.shouldGuard(inst);
      switch (state.phase) {
        case 'INSTALLING': {
          if (st.running) { stateMachine.setRunning(stateDeps(), inst, st, now); break; }
          if (state.installOk === true) {
            const r = _systemdStart(inst);
            if (!r.ok) stateMachine.restart(stateDeps(), inst, '启动失败:' + r.error);
            break;
          }
          if (state.installOk === false) { stateMachine.fail(stateDeps(), inst, state.installError || '安装失败'); break; }
          if (tasks) {
            if (!tasks.current('instance', inst.id)) {
              let why = null;
              try {
                const recent = tasks.list('instance').find((t) => t.target && t.target.id === inst.id && t.action === 'install');
                if (recent && (recent.state === 'failed' || recent.state === 'canceled')) why = recent.error || '安装失败';
              } catch {}
              if (!why && state.installAt && now - state.installAt > 10 * 60 * 1000) why = '安装超时(10分钟)';
              if (why) stateMachine.fail(stateDeps(), inst, why);
            }
          } else if (state.installAt && now - state.installAt > 10 * 60 * 1000) {
            stateMachine.fail(stateDeps(), inst, '安装超时(10分钟)');
          }
          break;
        }
        case 'STARTING': {
          if (st.running) stateMachine.setRunning(stateDeps(), inst, st, now);
          else if (state.startAt && now - state.startAt > 30000) stateMachine.restart(stateDeps(), inst, '启动超时: DSH 未监听端口');
          break;
        }
        case 'RUNNING': {
          if (!st.running) {
            runtime.delete(inst.id);
            state.usage = null;
            if (guarded) stateMachine.restart(stateDeps(), inst, '实例进程退出');
            else stateMachine.setStopped(stateDeps(), inst);
          } else if (inst.domain === 'sandbox') {
            if (tokens) tokens.ensureCaptured(inst.id);
            _governTick(inst, st);
          }
          break;
        }
        case 'BACKOFF': {
          if (!guarded) { stateMachine.setStopped(stateDeps(), inst); break; }
          if (state.backoffUntil && now >= state.backoffUntil) {
            start(inst.id).then((r) => {
              if (!r || (!r.ok && !r.installing)) stateMachine.restart(stateDeps(), inst, '重试失败:' + ((r && r.error) || ''));
            }).catch((e) => stateMachine.restart(stateDeps(), inst, '重试异常:' + (e && e.message)));
          }
          break;
        }
        case 'FAILED': {
          if (!guarded) break;
          if (state.installOk === true && !st.running && !/重试超限/.test(state.lastError || '')) {
            const r = _systemdStart(inst);
            if (!r.ok) stateMachine.restart(stateDeps(), inst, '启动失败:' + r.error);
          }
          break;
        }
        default: break;
      }
      store.save();
    } catch (e) {
      logger.error && logger.error('supervise ' + inst.id + ' error: ' + e.message);
    }
    return { ok: true };
  }
  return { _prepareSystemd, start, stop, probe, probeInstance, supervise, governSweep };
}
module.exports = { createLifecycle };
