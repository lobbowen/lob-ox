'use strict';
const fs = require('node:fs');
const monitor = require('../../platform/service/monitor');
const BRAND = require('../../shared/brand');
const ports = require('../../platform/service/ports').shared;
const guardian = require('../../shared/guardian');
const sandbox = require('./sandbox');
const stateMachine = require('./state-machine');
const execPath = require('../../platform/os/exec-path');
// 进程所有权归壳：沙箱实例拉起后必须上报到壳的进程表，否则壳的 heal 看不到它、
// 停机时也不知道要停它。此前只有 ManagedRegistry（守卫遗物）会上报，
// 而那张表全仓零 register 调用——沙箱实例实际从不在任何进程表里。
const pmClient = require('../../platform/contract/pm-client');
function createLifecycle(deps) {
  const { store, service, logger, events, tokens, tasks, systemdDir, systemdTemplatePath, hooks, instancesRoot, resstats } = deps;
  const isSandboxSupported = deps.isSandboxSupported;
  
  
  const stateDeps = () => ({ events, logger, save: () => store.save(), tokens, throttle: deps.throttle });
  const runtime = new Map();
  function _prepareSystemd() {
    if (!service.supportsUnits) return true;
    try {
      fs.mkdirSync(systemdDir, { recursive: true });
      if (fs.existsSync(systemdTemplatePath)) {
        const stamp = Date.now();
        
        let aside = systemdTemplatePath + BRAND.SYSTEMD_TEMPLATE_ASIDE_SUFFIX + stamp;
        let n = 1;
        while (fs.existsSync(aside)) { aside = systemdTemplatePath + BRAND.SYSTEMD_TEMPLATE_ASIDE_SUFFIX + stamp + '-' + (n++); }
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
      
      const takenBy = ports.recordOf(inst.port);
      if (takenBy && takenBy.owner !== 'inst:' + inst.id) {
        const msg = 'PORT_TAKEN:' + (takenBy.owner || takenBy.role);
        inst.state.lastError = msg;
        store.save();
        if (events) events.append('inst_start_refused', { id: inst.id, name: inst.name, error: msg });
        logger.warn && logger.warn('[' + inst.id + '] ' + msg);
        return { ok: false, error: msg };
      }
      
      
      if (probe(inst).portTaken) return { ok: false, error: '端口 ' + inst.port + ' 已被占用' };
      const { env, workingDir } = sandbox.sandboxEnv(instancesRoot, inst);
      const ctx = sandbox.launchCtx(instancesRoot, deps.dshBin, inst);
      _cleanStaleUnit('dsh-web@' + inst.id, ctx);
      try {
        service.startTransient({ unit: 'dsh-web@' + inst.id, cmd: cmdArr, env, workingDir, port: ctx.port, pidFile: ctx.pidFile, anchors: ctx.anchors });
      } catch (e) {
        const msg = 'systemd 启动失败: ' + (e.message || e);
        inst.state.lastError = msg;
        store.save();
        if (events) events.append('inst_start_failed', { id: inst.id, name: inst.name, error: msg });
        return { ok: false, error: msg };
      }
      inst.state.phase = 'STARTING';
      inst.state.startAt = Date.now();
      inst.state.restartAt = null;
      inst.state.lastError = null;
      
      
      if (opts && (opts.manual || opts.fromUpgrade)) {
        const hadOldChain = stateMachine.clearStartupFailures(inst);
        if (opts.manual) inst.state.restartCount = 0;
        inst.state.lastFailAt = null;
        if (hadOldChain && events) {
          events.append('inst_startup_retry', { id: inst.id, name: inst.name, manual: !!opts.manual, fromUpgrade: !!opts.fromUpgrade });
        }
      }
      store.save();
      // 向壳的进程表注册。两项都不可省：
      //   spawn_cmd —— 壳能独立执行的完整命令（含 node 与入口）。传空数组会让
      //     heal_candidates 直接跳过（process_manager/mod.rs 的 is_empty 判断），
      //    而那正是旧 ManagedRegistry 的做法（spawn_cmd: []）——壳从来无法自愈它。
      //   env —— sandboxEnv 的 11 个重定向变量。壳 heal 重拉时会原样应用，
      //     否则重拉的进程写进真实用户目录，「各自独立数据目录」在自愈路径上失效。
      pmClient.register({
        id: 'sandbox:' + inst.id,
        spawn_cmd: cmdArr,
        priority: 3,   // Sandbox：见 shell/src-tauri/src/process_manager/state_machine.rs
        env,
      });
      pmClient.setDesired('sandbox:' + inst.id, 'running');
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
  
  
  async function stop(id) {
    const inst = store.instances.find((i) => i.id === id);
    if (!inst) return { ok: false, error: '实例不存在' };
    if (!isSandboxSupported()) return { ok: false, error: '当前平台不支持沙箱实例（能力矩阵见 GET /env/status 的 capabilities.sandboxLaunch；限额执行档位见 capabilities.sandboxEnforcement）' };
    const unit = 'dsh-web@' + inst.id;
    let stopped;
    try { stopped = await service.stopUnit(unit, Object.assign({ timeoutMs: 20000 }, sandbox.launchCtx(instancesRoot, deps.dshBin, inst))); }
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
    // 相位同步给壳：壳据此不再 heal 这个实例（desired=stopped）。
    pmClient.setDesired('sandbox:' + inst.id, 'stopped');
    pmClient.onPhase('sandbox:' + inst.id, 'stopped');
    stateMachine.clearStartupFailures(inst);
    inst.state.usage = null;
    runtime.delete(inst.id);
    store.save();
    if (inst.port && hooks.onInstanceStop) hooks.onInstanceStop(inst);
    if (events) events.append('inst_stopped', { id: inst.id });
    return { ok: true };
  }
  
  
  function probe(inst) {
    return monitor.probeInstance(inst, { anchors: sandbox.launchCtx(instancesRoot, deps.dshBin, inst).anchors });
  }
  function probeInstance(id) {
    const inst = store.instances.find((i) => i.id === id);
    if (!inst) return { pid: null, running: false, isDsh: false, portTaken: false, identityUnknown: false, phase: 'STOPPED' };
    return probe(inst);
  }
  // 资源使用率采样。配额逻辑已按「共享系统资源」决策整段移除——
  // 这里只保留采样供 UI 展示实际用量，不做任何限制。
  function _sampleUsage(inst, st) {
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
        });
      }).catch(() => {});
    }
  }

  
  
  
  function supervise(id) {
    const inst = store.instances.find((i) => i.id === id);
    if (!inst || inst.domain === 'native') return { ok: true, skipped: !inst ? 'not-found' : 'native' };
    // 每次 supervise 都把真实相位报给壳：壳的 heal_candidates 只捞
    // 「desired=running 且 phase=failed」的对象，相位不报它就不会自愈。
    pmClient.onPhase('sandbox:' + inst.id, inst.state && inst.state.phase ? inst.state.phase.toLowerCase() : 'stopped');
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
            if (!r.ok) stateMachine.restart(stateDeps(), inst, '启动失败:' + r.error, { startupFailure: true });
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
          
          if (st.running) { stateMachine.setRunning(stateDeps(), inst, st, now); break; }
          if (typeof state.restartAt === 'number') {
            if (now >= state.restartAt) {
              
              
              state.restartAt = null;
              Promise.resolve(start(inst.id)).then((r) => {
                if (!r || (!r.ok && !r.installing)) {
                  stateMachine.restart(stateDeps(), inst, '启动失败:' + ((r && r.error) || ''), { startupFailure: true });
                }
              }).catch((e) => {
                stateMachine.restart(stateDeps(), inst, '重试异常:' + ((e && e.message) || ''), { startupFailure: true });
              });
            }
            break; 
          }
          if (!state.startAt) {
            
            state.restartAt = now;
            break;
          }
          if (now - state.startAt > stateMachine.STARTUP_WINDOW_MS) {
            stateMachine.restart(stateDeps(), inst, '启动超时: DSH 未监听端口(' + Math.round(stateMachine.STARTUP_WINDOW_MS / 1000) + 's)', { startupFailure: true });
          }
          break;
        }
        case 'RUNNING': {
          if (!st.running) {
            runtime.delete(inst.id);
            state.usage = null;
            
            if (guarded) stateMachine.restart(stateDeps(), inst, '实例进程退出', { startupFailure: false });
            else stateMachine.setStopped(stateDeps(), inst);
          } else if (inst.domain === 'sandbox') {
            if (tokens) tokens.ensureCaptured(inst.id);
            _sampleUsage(inst, st);
          }
          break;
        }
        case 'FAILED': {
          
          
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
  return { _prepareSystemd, start, stop, probe, probeInstance, supervise };
}
module.exports = { createLifecycle };
