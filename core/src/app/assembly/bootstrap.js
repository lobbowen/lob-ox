'use strict';

const execPath = require('../../platform/os/exec-path');

// app/assembly/bootstrap.js —— 守卫启动序列（生命周期标记 / 首拍 / 心跳 / 各类看护定时器）。

const path = require('node:path');
const fs = require('node:fs');
const ports = require('../../platform/service/ports').shared;
const { createShellWatchdog } = require('../../domains/shell/watchdog');
const pidlook = require('../../platform/os/pidlookup');
const platform = require('../../platform/os/index');

/** 启动拍环境表单的延后量：守卫启动头几秒要把资源让给内核拉起，全量探测排在其后。 */
const ENV_FORM_STARTUP_DELAY_MS = 3000;

function _bootstrap(host) {
    // HTTP 服务由 root 注入的 startApi() 启动：app 不得 require api（契约 DS-3）。
    // markStarted 缺失会使 lifecycle.isReady() 恒 false（/readyz 失败），状态摘要无 startedAt。
    try {
      host.events.append('guard_started', {
        pid: process.pid,
        version: host.guardVersion,
        healthUrl: host.config.healthUrl,
        api: host.config.apiHost + ':' + host.config.apiPort,
      });
    } catch {}
    try { host.lifecycle.markStarted(); } catch {}
    host.logger.info('guard started v' + host.guardVersion + ' pid=' + process.pid);
    // 生命周期注册已在组装期完成，此处不重复。
    // 启动既成事实：环境表单的 startup 维度只读这一份，本函数逐点把**已经发生或已经算出**的值抄进来，
    //   不做任何新判定 —— 快照要能回答「这一拍到底跑到过哪一步」，而这只有走到这里的人才知道。
    host._startupFacts = {
      bootAt: Date.now(), envDelayMs: ENV_FORM_STARTUP_DELAY_MS,
      routerAutostart: host.config.routerAutostart === true,
      routerMode: null, updateCheck: null, shellWatchdog: null, lastRefresh: null,
    };
    host.tick(); // 首拍立即收敛
    // 唯一心跳（registry heartbeat -> dsh supervise -> _dshConverge）是唯一周期驱动，
    //   故不建 tick 定时器；仅 registry 不可用（极罕见）时保留兜底。
    host._timer = host.managedObjects ? null : setInterval(() => host.tick(), host.config.probeIntervalMs);
    // _heartbeatBusy 防慢拍重叠（并发会造成 daemon 双监督 / main 双收敛）。
    // 兜底释放必须有：心跳的 promise 若不 settle，busy 恒 true 而心跳永停（main 不 spawn/adopt、沙箱不退避重试、daemon 失联不拉起），且 /status 仍显示最后一次写入的 phase。
    //   故独立定时器在远大于正常拍的阈值后强制释放并记 warn，同时暴露 _lastHeartbeatAt / _heartbeatStalls 使停摆可观测。
    host._lastHeartbeatAt = Date.now();
    host._heartbeatStalls = 0;
    // 心跳代际（自增 beat id）：stall 兜底放行下一拍后旧拍仍在 await，
    //   旧拍迟到结算若无条件清 busy 就会清掉新拍标记（两拍重叠根因）。
    host._heartbeatBeat = host._heartbeatBeat || 0;
    // 拍宽必须在 setInterval 之前求值：它同时用作间隔与超时阈值。
    const heartbeatIv = host.config.probeIntervalMs || 5000;
    host._heartbeatTimer = setInterval(() => {
      if (host._heartbeatBusy) return;
      host._heartbeatBusy = true;
      const iv = heartbeatIv;
      const beat = ++host._heartbeatBeat; // 本拍代际
      host._lastHeartbeatAt = Date.now();
      // 兜底释放阈值必须大于最坏单拍上界：单对象超时 = iv x ADAPTER_TIMEOUT_TICKS(6)，
      //   遍历串行，N 个对象全卡死的最坏整拍 = N x 6 x iv；低于它会在正常最长拍中途误释放，
      //   放行第二拍而第一拍仍在 await。取最坏上界 + 一拍余量，保底 max(30000, iv x 12)。
      //   guard.unref：不拖住进程退出。
      const objCount = (host.managedObjects && typeof host.managedObjects.count === 'function')
        ? host.managedObjects.count() : 1;
      const stallMs = Math.max(30000, iv * 12, objCount * 6 * iv + iv);
      const guard = setTimeout(() => {
        if (host._heartbeatBusy && beat === host._heartbeatBeat) {
          host._heartbeatBusy = false;
          host._heartbeatStalls++;
          if (host.logger && host.logger.warn) {
            host.logger.warn('[heartbeat] 单拍超过 ' + stallMs + 'ms 未结算，强制释放防停摆（第 ' + host._heartbeatStalls + ' 次）');
          }
        }
      }, stallMs);
      if (guard && typeof guard.unref === 'function') guard.unref();
      Promise.resolve(host.managedObjects ? host.managedObjects.heartbeat(iv) : null)
        .catch(() => {})
        .finally(() => {
          clearTimeout(guard);
          if (beat === host._heartbeatBeat) host._heartbeatBusy = false;
        });
    }, heartbeatIv);
    // 远程控制：为已开启远程控制的实例补建代理（幂等）。
    // relay/frpc 由独立 lan-daemon 承载：守卫只写状态并拉起/监督 daemon，不在本地建 relay。
    if (host.lanDaemonEnabled()) {
      host._syncLanState();
      const lrt = host._ensureLanRuntime(true);
      if (host.logger && host.logger.info) host.logger.info('[lan] L3b 模式：lan-daemon ' + (lrt.mode === 'daemon' ? ('已就绪 pid=' + (lrt.spawned || '(既有)')) : ('未就绪 mode=' + lrt.mode)));
    } else {
      host.lan.reconcile().catch(() => {});
      host.lan.syncFrpc();
    }
    // 沙箱实例监督并入唯一心跳的 sandbox-instance adapter（逐实例 supervise ->
    //   InstanceManager.supervise）；registry 不可用时兜底自持定时器。
    if (!host.managedObjects) host.instances.startTimer(host.config.probeIntervalMs || 5000);
    // 守卫启动只是守卫自身的生命周期：绝不在启动时注册/拉起/切换任何实例（含 main）。
    //   main 是否纳管由各实例自己的［进程守护 guardian］开关 + 自身生命周期决定。
    if (!host.lanDaemonEnabled()) {
      for (const inst of host.instances.all()) { if (inst.remoteMode === 'lan' || inst.remoteMode === 'wan') host.lan.syncProxy(inst).catch(() => {}); }
    }
    if (host.config.routerAutostart === true) {
      const rlc = host.lifecycleManager ? host.lifecycleManager.get('router') : null;
      if (rlc) { rlc.wantRunning(); rlc._monitoring = true; rlc._setPhase && rlc._setPhase('starting'); }
      // 独立 router-daemon 优先：在跑则监督它（不再内嵌启动，避免双占 43011）；未跑则拉起
      //   独立 daemon（detached）；daemon 不可用（脚本缺失）才退回内嵌。
      // 接管既有 daemon（守卫重启/手动拉起）时先落管理锁（本守卫目录），监督/启停权归本守卫。
      if (host._routerDaemonActive()) host._writeRouterDaemonLock();
      const rt = host._ensureRouterRuntime(true);
      host._startupFacts.routerMode = rt.mode;
      if (rt.mode === 'daemon') {
        // providers.json 等状态写权归 daemon（守卫只读，防双写覆盖）；
        //   该纪律已在 _ensureRouterRuntime 内统一处置，本行是幂等兜底。
        host._disableRouterPersist();
        if (rt.spawned) {
          // 刚拉起：3s 后单次探测 ctl 端口判就绪（非轮询循环）
          setTimeout(() => {
            const up = pidlook.findListeningPid(host._routerCtlPort());
            if (rlc) { if (up) { rlc._setPhase('running'); rlc.startedAt = rlc.startedAt || new Date().toISOString(); } else { rlc._setPhase('starting'); } /* healthy 由 _supervise mirror 观测置位 */ }
          }, 3000);
        } else if (rt.active) {
          if (rlc) { rlc._setPhase('running'); rlc.startedAt = rlc.startedAt || new Date().toISOString(); } /* healthy 由 _supervise mirror 观测置位 */
        }
      }
      // daemon 不可用 -> 内嵌 router 回退路径
      if (rt.mode !== 'daemon') host.router.start().then((r) => {
        if (rlc) { if (r && r.ok !== false) { rlc._setPhase('running'); rlc.startedAt = rlc.startedAt || new Date().toISOString(); } else { rlc._setPhase('stopped'); rlc.error = (r && r.error) || 'start 失败'; } /* healthy 由 _supervise mirror 观测置位 */ }
        if (r && r.ok === false) host.logger.warn('中转服务启动失败：' + (r.error || '未知错误'));
      });
    } else {
      const rlc = host.lifecycleManager ? host.lifecycleManager.get('router') : null;
      if (rlc) { rlc.desired = 'stopped'; rlc._monitoring = false; }
    }
    const checkDelayMs = host.config.initialCheckDelayMs || 20000;
    const checkIntervalMs = host.config.updateCheckIntervalMs || 3600000;
    // 先记后判：禁用是一条既成事实，留在 null 里就与「还没跑到这一步」分不开（排障会被引向等一拍）。
    host._startupFacts.updateCheck = {
      enabled: host.config.updateCheckEnabled !== false,
      initialDelayMs: checkDelayMs, intervalMs: checkIntervalMs,
    };
    if (host.config.updateCheckEnabled !== false) {
      host._initialCheckTimer = setTimeout(() => {
        host.nativeManager.checkUpdate();
      }, checkDelayMs);
      host._upgradeTimer = setInterval(() => {
        host.nativeManager.checkUpdate();
      }, checkIntervalMs);
    }
    // 失败隔离在此调用点同样执行：任何异常都不得影响守卫主循环 —— 看护是增强，不是依赖。
    //   异常冒泡会让调用方拿不到「已启动」，故包 try/catch 只记 warn。
    try {
      host._startShellWatchdog();
    } catch (e) {
      if (host.logger && host.logger.warn) {
        host.logger.warn('[shell-watchdog] 启动异常（不影响守卫主循环）: ' + ((e && e.message) || e));
      }
    }
    host._startupFacts.shellWatchdog = !!host.shellWatchdog;
    // 环境表单的启动一拍：异步维度（运行时/DSH/出网条件）只有走 refresh 才会有读数，而读数是
    //   后续一切分发的依据 —— 不在这里拍，面板与一键登录就只能永远看到 pending。
    //   延后若干秒：守卫启动头几秒要把 CPU/磁盘让给内核拉起，探测排在其后；句柄 unref，不拖住退出。
    const envTimer = setTimeout(() => {
      try { host._refreshEnvironmentForm(); } catch (e) {
        host.logger.warn && host.logger.warn('[environment] 启动刷新异常（不影响守卫主循环）: ' + ((e && e.message) || e));
      }
    }, ENV_FORM_STARTUP_DELAY_MS);
    if (envTimer && envTimer.unref) envTimer.unref();
}

/** 环境表单全量刷新一次并落快照（快照是给人回看的留痕，写失败只记 warn）。
 *  哪些维度没取到读数必须说得出口：pending/错误若只躺在 JSON 里，真机排障就还是「问一处答两处」。 */
function _refreshEnvironmentForm(host) {
  const startedAt = Date.now();
  return platform.environment.refresh({ persist: true }).then((f) => {
    const secs = (f && f.sections) || {};
    const pending = Object.keys(secs).filter((id) => secs[id] && secs[id].state === 'pending');
    const failed = Object.keys(secs).filter((id) => secs[id] && secs[id].state === 'error');
    const snap = f && f.snapshot ? f.snapshot : {};
    // 这一拍的收尾情况抄进启动事实：startup 维度由此能答出「最后一次刷新什么时候、耗时多少、
    //   哪些维度仍没读数」，而这些都是本函数刚刚算出来的既有值，不是第二份判定。
    if (host._startupFacts) {
      const states = {};
      for (const id of Object.keys(secs)) states[id] = secs[id] ? secs[id].state : 'missing';
      host._startupFacts.lastRefresh = {
        at: (f && f.at) || null, tookMs: Date.now() - startedAt, dims: states,
        browsers: (f && f.browsers && f.browsers.length) || 0,
        pick: (f && f.pick && f.pick.how) || null,
        snapshotWritten: snap.written === true,
      };
    }
    if (snap.written === false && snap.error) {
      host.logger.warn && host.logger.warn('[environment] 快照未落盘: ' + snap.error);
    }
    if (failed.length) {
      host.logger.warn && host.logger.warn('[environment] 维度探测失败: ' + failed.map((id) => id + '(' + secs[id].error + ')').join('; '));
    }
    if (pending.length) {
      host.logger.warn && host.logger.warn('[environment] 维度无探针，本机该项不可判: ' + pending.join(','));
    }
    host.logger.info && host.logger.info('[environment] 已刷新：' + Object.keys(secs).length + ' 个维度，浏览器候选 '
      + ((f && f.browsers && f.browsers.length) || 0) + ' 个，分发依据 ' + ((f && f.pick && f.pick.how) || '?'));
    return f;
  }).catch((e) => {
    // refresh 内部逐维已捕获异常，能到这里的是表单装配本身出错：如实留痕，绝不冒泡进守卫主循环。
    host.logger.warn && host.logger.warn('[environment] 刷新失败（不影响守卫主循环）: ' + ((e && e.message) || e));
    return null;
  });
}

function _startShellWatchdog(host) {
    if (host.config.shellWatchdog === false) {
      host.logger.info && host.logger.info('[shell-watchdog] 已按配置禁用');
      return;
    }
    try {
      host.shellWatchdog = createShellWatchdog({
        shell: host.shellDomain,
        pidlookup: pidlook, desktop: platform.desktop,
        logger: host.logger,
        events: host.events,
        config: host.config,
        // 退出门下沉到看护域：tick() 的一切调用者受同一门约束，合取式收敛为单源谓词
        //   host._shellExitIntended()（通用退出 或 持久 _shellHalted）。壳看护属桌面壳域，
        //   须含 shellHalted（退出管家后守卫重启不得把壳拉回）；主 DSH 收敛用 _exitIntended。
        halted: () => host._shellExitIntended(),
        // 壳已在线 = 用户重新打开了壳 -> 清除持久退出标记（否则自愈被永久抑制）。
        //   只在非退出中清：退出握手期间壳还会存活数百 ms，此时误清会让守卫重启后又把壳拉回。
        onShellAlive: () => {
          if (!host._shellHalted) return;
          if (host._stopping) return;
          if (host._sessionHalting && host._sessionHalting()) return;
          host._shellHalted = false;
          try { host.writeState(true); } catch {}
        },
      });
      host._shellWatchdogTimer = setInterval(() => {
        // 不在本闭包内短路退出门：否则「壳已在线 -> 清持久退出标记」永不执行；
        //   退出门由看护域统一裁决（见上 halted/onShellAlive）。
        Promise.resolve(host.shellWatchdog.tick()).catch(() => {});
      }, host.shellWatchdog.intervalMs);
      if (host._shellWatchdogTimer.unref) host._shellWatchdogTimer.unref();
      host.logger.info && host.logger.info('[shell-watchdog] 已启用（周期 ' +
        Math.round(host.shellWatchdog.intervalMs / 1000) + 's）');
    } catch (e) {
      host.logger.warn && host.logger.warn('[shell-watchdog] 初始化失败（不影响守卫）: ' + ((e && e.message) || e));
    }
}


function _registerFixedPorts(host) {
    // 端口来源以配置为准（healthUrl / command --port，normalize 已统一）。
    //   不做 pgrep 启发式猜端口：同一 bin 的其它实例/残留进程会劫持监管目标。
    // supervisor-api 用 registerSole：本次 listen 前先把同 role 的历史残留清掉，
    //   否则上一次避让留下的旧端口记录会与配置端口并存，而壳与内核各自可能读到不同的一条。
    ports.register('dsh-main', host.config.targetPort);
    ports.registerSole('supervisor-api', host.config.apiPort);
}

function _bindNativeDshCommand(host) {
    try {
      const cmd = Array.isArray(host.config.command) ? host.config.command.slice() : [];
      const cur = cmd[1];
      // 显式路径（含分隔符或 ~）以用户为准，即使当前不存在也不覆盖（未装就如实报未装）。
      // 只有出厂默认/裸逻辑名才由检测填充，这正是「检测 -> 绑定」的边界。
      const isBare = !cur || cur === 'dsh' || cur === 'dsh.cmd' || (!/[\\/]/.test(cur) && !String(cur).startsWith('~'));
      if (!isBare) return;
      const d = execPath.resolveDsh();
      if (!d || !d.bin) return;
      host.config.command = d.isJs
        ? [d.runtime || process.execPath, d.bin, ...cmd.slice(2)]
        : [d.bin, ...cmd.slice(2)];
      try { host.events && host.events.append('dsh_command_bound', { from: cur || null, to: host.config.command[1] }); } catch {}
      try { host.logger.info && host.logger.info('原生 DSH 已绑定: ' + host.config.command.join(' ')); } catch {}
    } catch (e) { try { host.logger.warn && host.logger.warn('原生 DSH 绑定失败: ' + (e && e.message)); } catch {} }
}

module.exports = { _bootstrap, _startShellWatchdog, _registerFixedPorts, _bindNativeDshCommand, _refreshEnvironmentForm };
