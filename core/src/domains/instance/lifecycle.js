'use strict';
// 协作方经 deps 显式注入；首次安装经 deps.install 注入（不 require upgrade，否则成环）。
// 服务操作全部经平台 Provider（deps.service），绝不直接调 systemctl。
const fs = require('node:fs');
const monitor = require('../../platform/service/monitor');
const ports = require('../../platform/service/ports').shared;
const guardian = require('../../shared/guardian');
const sandbox = require('./sandbox');
const governor = require('./governor');
const stateMachine = require('./state-machine');
// 执行边界复校与 api 形态闸共用同一纯函数（单一事实源）。
const execPath = require('../../platform/os/exec-path');
function createLifecycle(deps) {
  // resstats/machineFacts 为 W2 行为测试注入缝（显式注入，不 patch 模块导出）。
  const { store, service, logger, events, tokens, tasks, systemdDir, systemdTemplatePath, hooks, instancesRoot, resstats, machineFacts } = deps;
  const isSandboxSupported = deps.isSandboxSupported;
  // 状态转移副作用集合（落盘/发事件/令牌）：取用点现读 deps，避免快照漂移。
  const stateDeps = () => ({ events, logger, save: () => store.save(), tokens });
  // 运行时观测缓存（不落盘、守卫重启即空）：id -> { last:{t,cpuMs}, rssMb, cpuPct, memTicks, cpuTicks }，
  // 只存当拍瞬时事实；迟滞基准另取 state.allocation（跨重启保持）。
  const runtime = new Map();
  const machineFactsNow = () => (typeof machineFacts === 'function' ? machineFacts() : governor.machineFacts());
  /** 准备 systemd 用户目录，并将历史遗留模板改名让位（模板阻挡 systemd-run transient 单元；改名等效阻断且绝不删数据）。
   *  W3：仅单元档执行——portable 档无此目录可准备，且在 win/mac 不留结构残留。 */
  function _prepareSystemd() {
    if (!service.supportsUnits) return true;
    try {
      fs.mkdirSync(systemdDir, { recursive: true });
      if (fs.existsSync(systemdTemplatePath)) {
        // 让位目标名带 epoch 时间戳保证唯一：固定名需先 rmSync，会静默删掉用户文件。
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
  /** 清理残留同名 transient 单元（文件残留会让 systemd-run 报 already loaded）。
   *  ctx 为 portable 档身份锚（run.pid/端口），旧进程仍活时由其先停再清；systemd 档忽略这些附加字段。 */
  function _cleanStaleUnit(unit, ctx) {
    const r = service.cleanTransient(unit, ctx);
    if (r && r.ok === false) {
      logger.warn && logger.warn('clean stale transient unit 未完全生效: ' + unit +
        (r.errors && r.errors.length ? ' errors=' + r.errors.join(';') : ''));
    } else {
      logger.info && logger.info('cleaned stale transient unit: ' + unit);
    }
  }
  /** 用 systemd 启动实例；绝不抛（抛会打挂 tick 循环），失败返回 {ok,error} 交调用方退避。
   *  opts.manual：本次拉起来自用户显式动作（开新失败链，见 B2-6d 清计数处）。 */
  function _systemdStart(inst, opts) {
    try {
      const cmdArr = sandbox.effectiveCommand(instancesRoot, deps.dshBin, inst);
      if (!cmdArr || !cmdArr.length) return { ok: false, error: '实例未配置启动命令' };
      // 执行边界复校：effectiveCommand 对用户显式 command 原样返回，故执行前用 realpath 归属复校，
      // 收口「basename 改名绕过」与「伪包内路径」；允许位置 = 实例安装根或内核已知 DSH 入口，
      // 不可解析一律 fail-closed。仅 sandbox 域：native/main 命令来自操作者配置文件、非 API 供给的攻击面，复校会误拒合法入口。
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
      // 端口预校验（B2-5 或然侧）：注册表是跨进程共享事实源（lan-daemon 的 relay 绑定同在
      // ports.json），配置端口被他人登记时立即显式 PORT_TAKEN:<by>。静默端口的 TCP 探测
      // 看不见「已登记未监听」，放任下去只会在 systemd 起舱后以 bind 失败暴露，面板无从定位。
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
      // 启动时刻按机器预算与活跃实例数推导配额，记入 state 作为面板生效值。
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
      // B2-6d：手动拉起开新失败链。attempts>20 后 restart() 即回 FAILED 且清零只靠
      //   稳定 RUNNING>5min，fail() 承诺的「由用户手动重试」被计数封死；手动动作在此
      //   一次性作废旧链，自动退避计数仍只在监督拍累加（不带 opts 的调用方）。
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
  /** 拉起实例（独立 unit）；async：沙箱首次启动需异步安装 DSH。 */
  async function start(id, opts) {
    const inst = store.instances.find((i) => i.id === id);
    if (!inst) return { ok: false, error: '实例不存在' };
    if (!isSandboxSupported()) return { ok: false, error: '当前平台不支持沙箱实例（能力矩阵见 GET /env/status 的 capabilities.sandboxLaunch；限额执行档位见 capabilities.sandboxEnforcement）' };
    _prepareSystemd(); // 手动启动不受「守护(自动拉起)」开关限制
    // fromUpgrade 旁路（tasks 与准入同源）：升级作业自身的重启验证必须真正走到拉起，不被自己的作业挡住。
    if (inst.domain === 'sandbox') {
      const fromUpgrade = !!(opts && opts.fromUpgrade);
      if (!fromUpgrade && tasks && tasks.isBusy('instance', id)) return { ok: true, installing: true, already: true };
      // 准入控制（W2）：分摊薄后跌破单实例下限时显式拒绝，绝不静默放行超卖；BACKOFF 重试不旁路，
      // 被拒后按 restart() 计数走到「重试超限 FAILED」，失败可见可查。
      if (!fromUpgrade) {
        const adm = governor.admission(store.instances, inst.id, machineFactsNow().totalMemBytes);
        if (!adm.ok) {
          logger.warn && logger.warn('[' + inst.id + '] ' + adm.error);
          return { ok: false, error: adm.error };
        }
      }
      // 运行意图不设第二落点（B2-1）：自动拉起只认 guardian，用户启停就是动作本身；
      //  被拒的 start（作业在飞、预算已满）不留任何状态，重试语义由准入拒绝本身表达。
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
  /** 停止实例。自动来源（升级、插件生效重启）与用户停走同一路径：意图没有第二落点，
   *  恢复由调用方的后续 start（升级收尾重拉）表达。 */
  function stop(id) {
    const inst = store.instances.find((i) => i.id === id);
    if (!inst) return { ok: false, error: '实例不存在' };
    if (!isSandboxSupported()) return { ok: false, error: '当前平台不支持沙箱实例（能力矩阵见 GET /env/status 的 capabilities.sandboxLaunch；限额执行档位见 capabilities.sandboxEnforcement）' };
    const unit = 'dsh-web@' + inst.id;
    let stopped;
    try { stopped = service.stopUnit(unit, Object.assign({ timeoutMs: 20000 }, sandbox.launchCtx(instancesRoot, deps.dshBin, inst))); } // 有界，防 dbus 挂起冻结守卫；ctx 为 portable 档身份锚
    catch (e) { stopped = false; logger.warn && logger.warn('[' + inst.id + '] 停止单元 ' + unit + ' 异常: ' + (e && e.message)); }
    if (stopped === false) {
      // 停止未确认：保持原相位、如实报错（谎报已停会让 supervise 不再自愈）。
      const msg = '停止实例失败（单元 ' + unit + ' 未确认停止）';
      inst.state.lastError = msg;
      store.save();
      if (events) events.append('inst_stop_failed', { id: inst.id, name: inst.name, error: msg });
      logger.warn && logger.warn('[' + inst.id + '] ' + msg);
      return { ok: false, error: msg };
    }
    inst.state.phase = 'STOPPED';
    inst.state.usage = null; // 用户显式停止同样清观测（与 RUNNING 分支同源语义）
    runtime.delete(inst.id);
    store.save();
    if (inst.port && hooks.onInstanceStop) hooks.onInstanceStop(inst);
    if (events) events.append('inst_stopped', { id: inst.id });
    return { ok: true };
  }
  /** 在线探测统一交 platform/service/monitor（原生与沙箱共用）。 */
  function probe(inst) { return monitor.probeInstance(inst); }
  function probeInstance(id) {
    const inst = store.instances.find((i) => i.id === id);
    if (!inst) return { pid: null, running: false, isDsh: false, phase: 'STOPPED' };
    return probe(inst);
  }
  /** 沙箱花名册：只有 RUNNING 实例参与每拍决策；usage 读各自最近一次采样（陈旧上界一拍）。 */
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
  /** 控制面采样拍（每实例）：runtime 观测回填，供守卫单拍 governSweep 消费（B2-6e）。
   *  全花名册 decide 已移出——旧形态每 RUNNING 实例的监督拍各跑一遍 O(N) 决策，
   *  N 实例即 N 倍放大；决策/下发/处置的周期驱动与 heartbeat 同源、每拍恰一次。 */
  function _governTick(inst, st) {
    for (const key of Array.from(runtime.keys())) {
      if (!store.instances.some((i) => i.id === key)) runtime.delete(key); // 实例已删：观测随葬
    }
    if (resstats && st.pid) {
      Promise.resolve(resstats.sampleAsync(st.pid)).then((s) => {
        if (!s) return; // 采样失败 = 无证据：保持上一值，绝不按零占用参与决策
        const prev = runtime.get(inst.id) || {};
        const t = Date.now();
        let cpuPct = null;
        if (prev.last && t > prev.last.t) {
          const dw = t - prev.last.t;
          const dc = s.cpuMs - prev.last.cpuMs;
          if (dw > 0 && dc >= 0) cpuPct = Math.round((dc / dw) * 1000) / 10; // 单核满载 = 100
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

  /** 资源治理守卫单拍（heartbeat 尾钩）：观测->全花名册 decide->下发/处置恰一次。
   *  本拍消费上一拍采样值（采样异步回填）：无证据不判违规。 */
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
        // W3 运行期动态下发：单元活着才推（set-property 即时生效）；provider 无 setLimits = 无内核强制，
        // 如实跳过：展示值已更新、下次启动按新值生效，下发失败不走任何降级分支。
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
        // 经 Provider 动词：cgroup 档即内核拆舱；portable 档按端口/run.pid 锚点整树终止（W3）。
        service.stopUnit('dsh-web@' + target.id, Object.assign({ timeoutMs: 20000 }, sandbox.launchCtx(instancesRoot, deps.dshBin, target)));
      } catch (e) {
        logger.warn && logger.warn('[' + target.id + '] 违规停单元异常: ' + (e && e.message));
      }
      stateMachine.restart(stateDeps(), target, reason); // 复用既有退避链：BACKOFF，重试超限 -> FAILED
    }
    store.save(); // 下发/处置改写的 allocation/usage 随本拍落盘（旧实现借道 supervise 尾 save，现自成一体）
    return { ok: true, entries: plan.entries.length };
  }
  /** 单实例监督拍：整体 try/catch，单实例异常绝不拖垮心跳循环。 */
  function supervise(id) {
    const inst = store.instances.find((i) => i.id === id);
    if (!inst || inst.domain === 'native') return { ok: true, skipped: !inst ? 'not-found' : 'native' };
    const now = Date.now();
    try {
      const st = probe(inst);
      inst.state.lastProbeOk = st.running;
      // 令牌回填与 phase 解耦：长驻/孤立实例在守卫重启后不回填令牌，relay 会无 cookie 401。
      if (inst.domain === 'sandbox' && tokens) { try { tokens.ensureCaptured(inst.id); } catch {} }
      const state = inst.state;
      const guarded = guardian.shouldGuard(inst); // 只影响「挂了是否自动拉起」，不影响手动启动
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
            // 无作业行不直接判死：任务登记失败或守卫中断时安装可能仍在进行，立即判死会永久卡 FAILED；
            // 仅在确证作业失败/取消或安装超时（10 分钟）时判死。
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
            stateMachine.fail(stateDeps(), inst, '安装超时(10分钟)'); // 无任务注册表环境的看护兜底
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
            state.usage = null; // 观测行随运行态清零，防停止实例显示陈旧占用
            if (guarded) stateMachine.restart(stateDeps(), inst, '实例进程退出');
            else stateMachine.setStopped(stateDeps(), inst);
          } else if (inst.domain === 'sandbox') {
            if (tokens) tokens.ensureCaptured(inst.id); // 内存令牌空置时周期回填（服务内部 30s 节流）
            _governTick(inst, st);
          }
          break;
        }
        case 'BACKOFF': {
          // BACKOFF 重试同属「自动拉起」：未守护一律落 STOPPED，绝不无限退避重试（破「停就停」红线）。
          if (!guarded) { stateMachine.setStopped(stateDeps(), inst); break; }
          if (state.backoffUntil && now >= state.backoffUntil) {
            start(inst.id).then((r) => {
              if (!r || (!r.ok && !r.installing)) stateMachine.restart(stateDeps(), inst, '重试失败:' + ((r && r.error) || ''));
            }).catch((e) => stateMachine.restart(stateDeps(), inst, '重试异常:' + (e && e.message)));
          }
          break;
        }
        case 'FAILED': {
          // installOk===true 时自愈拉起：任务登记失败可能把已成功的安装误判 FAILED，不拉起会永久卡死；
          // 重试超限后交用户处理；未守护实例不做任何自愈拉起（installOk 兜底同归守护语义）。
          if (!guarded) break;
          if (state.installOk === true && !st.running && !/重试超限/.test(state.lastError || '')) {
            const r = _systemdStart(inst);
            if (!r.ok) stateMachine.restart(stateDeps(), inst, '启动失败:' + r.error);
          }
          break;
        }
        default: break; // STOPPED：保持，由用户手动 start 重置
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
