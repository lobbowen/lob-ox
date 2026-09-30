'use strict';

// app/main/controller.js —— 主收敛执行器（_dshConverge）。
// 导出 { methods }，由 app/assembly/facets.js 装到 host；方法名与 { methods } 形态不可改：
// 令牌契约门禁读 _dshConverge 体、phase 迁移门禁读其 phase switch，均按源码形态匹配。
// 事实经 depsOf(host) 的按 host 惰性缓存取得，方法体保持零 this 调用。
const pidlook = require('../../platform/os/pidlookup');
const monitor = require('../../platform/service/monitor');
const { startDeadlinePassed } = require('./decide');

const DEPS = new WeakMap();
function depsOf(host) {
  let d = DEPS.get(host);
  if (!d) {
    d = {
      config() { return host.config; },
      main() { return host.main; },
      state() { return host.state; },
      session() { return host.session; },
      // 意图轴单源谓词（装配期由 collaborators 安装到 host）。
      exitIntended() { return host._exitIntended(); },
      events() { return host.events; },
      logger() { return host.logger; },
      ui() { return host.ui; },
      daemons() { return host.daemons; },
      intents() { return host.intents; },
      lan() { return host.lan; },
      control() { return host.control; },
      // 可变字段（readX/writeX；本文件源码须零禁用标识符，故成员名亦不含之）。
      readTicking() { return host._ticking; }, writeTicking(v) { host._ticking = v; },
      stopping() { return host._stopping; },
      writeActWindow(v) { host._actWindow = v; },
      writeMainTickActs(v) { host._mainTickActs = v; },
      readLastMainPortRederive() { return host._lastMainPortRederive; },
      writeLastMainPortRederive(v) { host._lastMainPortRederive = v; },
      upgradeHold() { return host._upgradeHold; }, writeUpgradeHold(v) { host._upgradeHold = v; },
      upgradeHoldSince() { return host._upgradeHoldSince; }, writeUpgradeHoldSince(v) { host._upgradeHoldSince = v; },
      manualRestart() { return host.manualRestart; }, writeManualRestart(v) { host.manualRestart = v; },
      writeCrashHalted(v) { host._crashHalted = v; },
      sessionState() { return host._sessionState; },
      // 字段 helper 经 host 既有安装转发。
      mChild() { return host._mChild(); },
      mAdoptPid() { return host._mAdoptPid(); },
      mObservedOnly() { return host._mObservedOnly(); },
      mSpawnBlockedUntil() { return host._mSpawnBlockedUntil(); },
      mStartDeadline() { return host._mStartDeadline(); },
      mSetStartDeadline(v) { return host._mSetStartDeadline(v); },
      mRestartAt() { return host._mRestartAt(); },
      mBackoffUntil() { return host._mBackoffUntil(); },
      mSetLastProbeAt(v) { return host._mSetLastProbeAt(v); },
      mSetLastProbeOk(v) { return host._mSetLastProbeOk(v); },
      mSetLastProbeHttpOk(v) { return host._mSetLastProbeHttpOk(v); },
      mSetAdoptPid(v) { return host._mSetAdoptPid(v); },
      mSetObservedOnly(v) { return host._mSetObservedOnly(v); },
      mSetSpawnBlockedUntil(v) { return host._mSetSpawnBlockedUntil(v); },
      mSetMissingNotified(v) { return host._mSetMissingNotified(v); },
      mSetBackoffUntil(v) { return host._mSetBackoffUntil(v); },
      mSetRestartAt(v) { return host._mSetRestartAt(v); },
    };
    DEPS.set(host, d);
  }
  return d;
}

module.exports = {
  methods: {
  // 唯一心跳驱动的收敛段（外部操作仍可即时触发）；单一状态机 STOPPED/STARTING/RUNNING/RESTARTING/BACKOFF。
  // main 由守卫统一 spawn/观测管理（不经 systemd 托管）。
  async _dshConverge() {
    const d = depsOf(this);
    if (d.readTicking() || d.stopping()) return;
    // INV-S1：守卫关停中或会话 halting（_exitIntended 单源谓词 = stopping 或 halting）时抑制一切自动拉起。
    if (d.exitIntended()) return;
    d.writeTicking(true);
    // 影子拍：收敛窗口打开（拍内实际执行动作记账，供影子对比 actual）
    d.writeActWindow(true);
    d.writeMainTickActs([]);
    let t0 = null; // 影子起点快照（try 内探测后赋值；finally 一定可见）
    try {
      // 统一健康探测（platform/service/monitor）：up = 端口在线，驱动状态机的在线/离线收敛（desired/升级 hold/接管均以端口为准）；
      // httpOk = HTTP 健康维度，端口在但 HTTP 挂（事件循环卡死/假死）时连续 failThreshold 次判故障。
      const probeRes = await monitor.probe(d.config().targetHost, d.config().targetPort, {
        httpProbeEnabled: d.config().httpProbeEnabled !== false,
        healthUrl: d.config().healthUrl,
        httpTimeoutMs: d.config().probeTimeoutMs || 3000,
      });
      const portUp = probeRes.up;
      const healthOk = probeRes.httpOk;
      d.mSetLastProbeAt(new Date().toISOString());
      d.mSetLastProbeOk(portUp);
      // HTTP 健康维度同源快照（startDeadline/健康收敛决策用）
      d.mSetLastProbeHttpOk(healthOk);
      // 拍起点快照（探测后、收敛前，与决策同输入同源）
      t0 = d.main().stateSnapshot();
      // dsh 生命周期视图由 finally 的 control.syncDshView 从目录 main entry 合成（不经观测镜像喂入）。
      const host = d.config().targetHost;
      const port = d.config().targetPort;
      // spawn 托管：目标在线 = 自有 child 或接管 pid 存活。
      const childAlive = d.mChild() !== null && d.mChild().exitCode === null && d.mChild().signalCode === null;
      const adoptedAlive = d.mAdoptPid() !== null && pidlook.isAlive(d.mAdoptPid());
      const targetAlive = childAlive || adoptedAlive;

      // 原生 DSH 端口运行时再推导兜底：期望运行/观测中，配置端口无监听但受管 DSH 进程在跑
      // （用户改了端口等）时从进程真实 --port 更正（30s 节流，防 churn）。
      if (!portUp && d.state().desired() !== 'stopped' && (childAlive || adoptedAlive || d.mObservedOnly())) {
        if (!d.readLastMainPortRederive() || Date.now() - d.readLastMainPortRederive() > 30000) {
          d.writeLastMainPortRederive(Date.now());
          const found = d.main().findManagedPort();
          if (found && found.port && found.port !== d.config().targetPort) {
            // 仅当 applyPort 成功（register 通过）才跟随；失败时保留旧配置，
            // 避免注册表/healthUrl 未变而 config 已改的分叉。
            if (d.main().applyPort(found.port, found.pid)) {
              d.config().targetPort = found.port;
            }
          }
        }
      }

      // 期望状态调和优先于「进程守护」开关（desired 是正交轴）。
      // 显式 start/stop 是用户意图，必须永远生效：守护开关只约束「崩溃后自动拉起」，
      // 绝不约束用户主动点「启动 DSH / 停止 DSH」。此分支置于守护短路之前。
      if (d.state().desired() === 'stopped') {
        const managedAlive = childAlive || (adoptedAlive && !d.mObservedOnly());
        if (managedAlive) {
          d.main().stopProcess('desired_stopped');
        } else if (adoptedAlive && d.mObservedOnly()) {
          if (d.state().phase() !== 'OBSERVED') {
            d.state().setPhase('OBSERVED');
            d.state().write();
          }
        } else if (portUp) {
          d.main().adoptObserved();
        } else {
          if (d.mAdoptPid() !== null && !adoptedAlive) {
            d.events().append('dsh_exited', { code: null, signal: null, adopted: true, observed: true });
            d.mSetAdoptPid(null);
            d.mSetObservedOnly(false);
          }
          if (d.state().phase() !== 'STOPPED') d.state().setPhase('STOPPED');
        }
        d.state().write();
        return;
      }

      // 升级 hold：安装期间不拉起；超时自愈防止 hold 卡死导致服务永久下线。
      if (d.upgradeHold()) {
        if (targetAlive) {
          d.main().stopProcess('upgrade_hold');
        } else {
          if (d.state().phase() !== 'STOPPED') d.state().setPhase('STOPPED');
          const maxHold = (d.config().upgradeTimeoutMs || 600000) + 120000;
          if (d.upgradeHoldSince() && Date.now() - d.upgradeHoldSince() > maxHold) {
            d.events().append('upgrade_hold_timeout', {});
            d.ui().notify('升级流程异常', '升级 hold 超时已自动释放，请检查升级状态');
            d.writeUpgradeHold(false);
            d.writeUpgradeHoldSince(null);
          }
        }
        d.state().write();
        return;
      }

      // 手动重启请求
      if (d.manualRestart()) {
        d.writeManualRestart(false);
        if (d.state().phase() === 'RUNNING' || d.state().phase() === 'STARTING') {
          d.main().beginRestart('manual', { countCrash: false }); // _beginRestart 内部会停运行中的目标（杀 child/接管 pid），避免重复停
        } else if (d.state().phase() === 'RESTARTING' || d.state().phase() === 'BACKOFF') {
          d.mSetBackoffUntil(null);
          d.mSetRestartAt(Date.now());
          if (!targetAlive) await d.main().startProcess();
        }
        // phase === 'STOPPED' 时落到下方 switch，让端口占用检查统一生效
      }

      switch (d.state().phase()) {
        case 'STOPPED': {
          if (portUp) {
            // 接管既有实例（校验 DSH cmdline；spawn 托管）
            d.main().adopt();
            d.mSetSpawnBlockedUntil(null);
            d.mSetMissingNotified(false);
          } else if (d.mSpawnBlockedUntil() && Date.now() < d.mSpawnBlockedUntil()) {
            // 命令缺失冷静期：等待安装，不做无谓重试
          } else if (await monitor.isPortListening(host, port, 1000)) {
            // 端口被不健康进程占用：不硬抢，只告警
            d.daemons().warnOccupied();
          } else if (d.session().shouldRun() && !d.exitIntended()) {
            // 拉起条件（意图单源）：desired=running 且会话非 halting 且非崩溃停靠即无条件拉起（重启后据此恢复），
            // 不要求 guardian/内存意图解锁；guardian 只约束崩溃后是否自动重启。
            // _shellHalted 属桌面壳域、不并入此处：否则 headless 无壳清除路径会死锁。
            d.intents().consume('start'); d.intents().consume('restart'); d.intents().consume('upgrade-resume'); // 意图一次性消费（加速器，非门槛）
            await d.main().startProcess();
          } else {
            // desired=stopped（用户期望停止）：保持停止（adopt 已有进程已在上方处理）
            if (d.state().phase() !== 'STOPPED') d.state().setPhase('STOPPED');
          }
          break;
        }
        case 'STARTING': {
          if (portUp && healthOk) d.main().enterRunning();
          else if (d.mStartDeadline() === null) {
            // 守卫从盘恢复且 phase=STARTING：startDeadline 是运行期字段不持久化，恢复后为空。
            // 判据与影子同源（缺 deadline=未到期），首拍重derive宽限，不当场杀在途启动、不误计崩溃。
            d.mSetStartDeadline(Date.now() + d.config().startTimeoutMs);
          }
          else if (startDeadlinePassed(d.mStartDeadline(), Date.now())) d.main().beginRestart('start_timeout', { countCrash: true });
          break;
        }
        case 'RUNNING': {
          // RUNNING 绝不读令牌：令牌恒存在（"拿不到"只是捕捉链路 bug），令牌与进程健康正交（SSOT TK-1/TK-2）。
          // 只按进程存活判断，进程死了才重启，不因端口探测失败误判。
          // 守护语义：guardian 开=崩溃自动拉起（退避自愈），关=回到停止态等用户手动启动。
          const guarded = d.state().guardian();
          if (d.mAdoptPid() !== null && adoptedAlive === false) {
            d.events().append('dsh_exited', { code: null, signal: null, phase: d.state().phase(), adopted: true });
            d.mSetAdoptPid(null);
            if (guarded) d.main().beginRestart('adopted_exit', { countCrash: true });
            else { d.writeCrashHalted(true); d.events().append('guardian_off_exit', { reason: 'adopted_exit 未守护，保持停止' }); d.state().setPhase('STOPPED'); }
          } else if (!childAlive && d.mChild()) {
            if (guarded) d.main().beginRestart('child_exit', { countCrash: true }); // exit 事件兜底
            else { d.writeCrashHalted(true); d.events().append('guardian_off_exit', { reason: 'child_exit 未守护，保持停止' }); d.state().setPhase('STOPPED'); }
          } else {
            // 假死识别：进程在但 HTTP 连续不健康时判故障。health-gate 只返回决策、执行在此（依赖单向 controller -> health-gate）。
            // 假死自愈不看 guarded（上面 adopted_exit / child_exit 才看）：进程仍活着且占着端口，
            // 若此处不重启会落回 STOPPED -> portUp 走 adopt 重新接管 -> 下一拍又被判假死，无限空转。故"假死必自愈"为有意设计。
            const healthDecision = d.main().applyHealthCheck(healthOk);
            if (healthDecision && healthDecision.restart) {
              d.main().beginRestart(healthDecision.reason || 'http_unhealthy', { countCrash: healthDecision.countCrash === true });
            }
          }
          break;
        }
        case 'RESTARTING': {
          if (portUp && healthOk && (!d.mChild() && !adoptedAlive)) {
            d.main().adopt();
          } else if (!targetAlive && Date.now() >= d.mRestartAt()) {
            // 重启前复查端口：避免对"占着端口的不健康外来进程"反复 spawn 计崩溃
            if (await monitor.isPortListening(host, port, 1000)) {
              d.daemons().warnOccupied();
            } else {
              await d.main().startProcess();
            }
          }
          break;
        }
        case 'BACKOFF': {
          if (portUp && healthOk && (!d.mChild() && !adoptedAlive)) {
            d.main().adopt();
          } else if (!targetAlive && Date.now() >= d.mBackoffUntil()) {
            if (await monitor.isPortListening(host, port, 1000)) {
              d.daemons().warnOccupied();
            } else {
              await d.main().startProcess();
            }
          }
          break;
        }
      }
      // 升级后的健康验证在实例升级路径（waitPortHealthy）内联完成，不经本收敛循环。
      // 远程代理自动对账：实例重启/恢复后自动重接 relay；reconcile 由 lan-daemon 每 2s 执行，
      // 守卫只写状态，不本地建 relay。
      if (!d.daemons().enabled()) { try { d.lan().reconcile().catch(()=>{}); } catch {} }
      d.state().write();
    } catch (e) {
      d.logger().error('tick error: ' + ((e && e.stack) || e));
    } finally {
      d.writeTicking(false);
      d.writeActWindow(false);
      // 会话态：首拍收敛完成，starting 迁移到 running。
      if (d.sessionState() === 'starting') d.session().setState('running');
      // 拍末记账（actual vs shadow；不受 tick 内提前 return 影响，必定执行）
      try { d.main().shadowTickNote(t0); } catch (e) { d.logger().warn && d.logger().warn('shadow note: ' + (e && e.message)); }
      // 统一生命周期视图同步：不受 tick 内提前 return 影响，守卫每次调和后把自身（DSH）
      // 观测状态镜像到 lifecycleManager。
      try { d.control().syncDshView(); } catch (e) { d.logger().warn && d.logger().warn('sync: ' + (e && e.message)); }
    }
  }
  },
};
