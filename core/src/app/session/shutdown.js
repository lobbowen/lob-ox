'use strict';

const platform = require('../../platform/os/index');
const distribution = require('../../platform/distribution');

// app/session/shutdown.js —— 关停编排：停被管对象、会话置 stopped、回执（绝不自行停止守卫）。

/** 关停不等在途 npm（装/卸载可达分钟级，守卫只有 8s 优雅期），但必须中止它：
 *  子进程 detached 自成进程组，不中止会在守卫死后继续写 node_modules/全局前缀，与新守卫并发。
 *  中止后对应 install()/uninstall() 以 ok:false,aborted:true 收口。
 *  @returns {number} 被中止的任务数 */
function abortInflightNpm(host, reason) {
    let n = 0;
    try {
      n = distribution.killInflightNpm(reason);
    } catch (e) {
      host.logger && host.logger.warn && host.logger.warn('shutdown abortInflightNpm: ' + ((e && e.message) || e));
      return 0;
    }
    if (n > 0) {
      host.logger && host.logger.warn && host.logger.warn('[shutdown] 中止在途 npm 任务 ' + n + ' 个（' + reason + '）：本次安装/卸载未完成，可在守卫恢复后重新发起');
      host.events && host.events.append('shutdown_npm_aborted', { count: n, reason });
    }
    return n;
}



function shutdown(host) {
    if (host._stopping) return host._shutdownPromise || Promise.resolve();
    host._stopping = true;
    // SIGTERM 到达且无进行中的会话退出 = 外部所有者（systemctl stop/注销）直接关停守卫。
    // 守卫是 Restart=always 的常驻自愈者，这等于「用户离开了」——必须落盘退出意图，
    // 否则被重新拉起后壳看护按 desired=running 又把壳拉回。壳侧 shutdownAll 在位时本分支跳过。
    if (!host._shellHalted && !host._sessionHalting()) {
      host._shellHalted = true;
      try { host.events.append('shell_halt_on_external_stop', {}); } catch {}
    }
    host.lifecycle.beginShutdown();
    host.events.append('guard_exit', {});
    host.logger.info('guard shutting down');
    host.writeState(true);
    if (host._timer) clearInterval(host._timer);
    if (host._heartbeatTimer) clearInterval(host._heartbeatTimer);
    if (host._killTimer) clearTimeout(host._killTimer);
    if (host._adoptKillTimer) clearTimeout(host._adoptKillTimer);
    // 先切断「守卫死后仍在写盘的 npm 子进程」，再进入停对象流程。
    abortInflightNpm(host, 'guard-shutdown');
    if (host._initialCheckTimer) clearTimeout(host._initialCheckTimer);
    if (host._upgradeTimer) clearInterval(host._upgradeTimer);
    if (host._shellWatchdogTimer) clearInterval(host._shellWatchdogTimer);
    if (host.api) {
      try {
        host.api.close();
      } catch {}
    }
    // router/lan 仍驻守卫进程（进程解耦完成前）时 shutdown 必须停它们防孤儿
    // （反代实例进程、relay/frpc、动态端口残留），统一经 lifecycleManager 出口。
    // stopAll 是 async 必须 await；Promise 存 _shutdownPromise 使重复调用幂等。
    host._shutdownPromise = (async () => {
      try {
        if (host.lifecycleManager) {
          // router 若为独立 daemon（detached）则豁免 stopAll：守卫退出不停它（其生命周期继续服务），
          // 仅内嵌 router/lan 需停防孤儿。
          try {
            const rlc = host.lifecycleManager.get('router');
            if (rlc && host._routerDaemonActive()) {
              rlc._monitoring = false; // 守卫退出不再监督该 daemon（daemon 自身继续运行）
            }
          } catch {}
          await host.lifecycleManager.stopAll('guard-shutdown', { exclude: ['dsh'] }); // 守卫退出绝不动 DSH（RC2 契约）
        } else {
          // 兜底：lifecycleManager 未初始化时防孤儿
          try { if (host.lan) await host.lan.shutdown(); } catch (e) { host.logger.warn && host.logger.warn('lan shutdown: ' + (e && e.message)); }
          try { if (host.router) await host.router.stop(); } catch (e) { host.logger.warn && host.logger.warn('router stop: ' + (e && e.message)); }
        }
      } catch (e) { host.logger.warn && host.logger.warn('lifecycle stopAll: ' + (e && e.message)); }
    })();
    return host._shutdownPromise;
}

async function shutdownAll(host) {
    // 幂等：已进入退出流程则直接回执当前态（壳可安全重试/轮询）
    if (host._sessionHalting()) return { ok: true, already: true, sessionState: host._sessionState };
    host._setSessionState('stopping'); // 抑制一切自动拉起（INV-S1）
    // 会话态只活内存：守卫被外部/登录重新拉起即遗忘退出意图。落盘 shellHalted 防中途被杀，
    // 新守卫 boot 经 loadState 继承；看护观测到壳在线（用户重开）时自动清除。
    host._shellHalted = true;
    try { host.writeState(true); } catch (e) { host.logger.warn && host.logger.warn('shutdownAll persist shellHalted: ' + e.message); }
    // 清周期定时器（壳看护/心跳/调和等）：sessionState=stopping 已抑制自动拉起，但那是运行期门；
    // 清定时器是与完整 shutdown() 对齐的第二道，防某适配器门遗漏时残留周期动作重新监督/拉起被管对象。
    if (host._shellWatchdogTimer) { clearInterval(host._shellWatchdogTimer); host._shellWatchdogTimer = null; }
    if (host._heartbeatTimer) { clearInterval(host._heartbeatTimer); host._heartbeatTimer = null; }
    if (host._timer) { clearInterval(host._timer); host._timer = null; }
    if (host._initialCheckTimer) { clearTimeout(host._initialCheckTimer); host._initialCheckTimer = null; }
    if (host._upgradeTimer) { clearInterval(host._upgradeTimer); host._upgradeTimer = null; }
    if (host._killTimer) { clearTimeout(host._killTimer); host._killTimer = null; }
    if (host._adoptKillTimer) { clearTimeout(host._adoptKillTimer); host._adoptKillTimer = null; }
    host.logger.info('[session] 退出流程开始：停止全部被管对象…');
    host.events && host.events.append('shutdown_all', {});
    // 中止在途 npm（不等其完成，理由见 abortInflightNpm 头注）。
    abortInflightNpm(host, 'session-exit');
    // 1) 停 DSH 主实例（本守卫是被管对象的所有者，契约）
    host._stopMainDsh();
    // 2) 停全部沙箱（按实际单元名——glob 不经 shell 不展开）
    await host._stopAllSandboxes();
    // 3) 停路由/远程 daemon（独立进程；DaemonLifecycle.stop 串行语义）。
    // stop() 如实返回 ok:false（进程未在超时内退出）：记事件+warn 让面板/日志可见，
    // 仍继续后续步骤，不阻断关停流程。
    const stopDaemon = async (kind) => {
      try {
        const lc = host._daemonLifecycle(kind);
        if (!lc) return;
        const r = await lc.stop();
        if (r && r.ok === false) {
          host.logger.warn && host.logger.warn('shutdownAll stop ' + kind + ' 未完成: ' + (r.error || '未知'));
          host.events && host.events.append('shutdown_daemon_stop_incomplete', { kind, pid: r.stopped || null, error: r.error || null });
        }
      } catch (e) { host.logger.warn && host.logger.warn('shutdownAll stop ' + kind + ': ' + e.message); }
    };
    await stopDaemon('router');
    await stopDaemon('lan');
    // 4) 会话置 stopped 并回执——守卫不停止自己：守卫所属单元的所有者是外部（systemd + 壳，
    //    契约）。壳收到回执后执行 systemctl --user stop，守卫进程随之收 SIGTERM 自然退出。
    host._setSessionState('stopped');
    host.writeState(true);
    host.events && host.events.append('session_stopped', {});
    host.logger.info('[session] 被管对象已全部停止；等待外部所有者（壳/systemd）停止守卫进程');
    return { ok: true, sessionState: 'stopped' };
}

function _stopMainDsh(host) {
    try {
      // 退出会话不等于改变用户运行意图（desired 仅在用户显式启停时改变）；
      // 「停后不再拉起」由 sessionState=stopping 抑制（INV-S1），保留 desired=running 供下次开壳恢复。
      if (host._mChild() || host._mAdoptPid()) { host.stopProcess('session_stop'); }
    } catch (e) { host.logger.warn && host.logger.warn('shutdownAll stop main: ' + e.message); }
}

async function _stopAllSandboxes(host) {
    // systemctl stop dsh-web@* 经 execFileSync 不走 shell，`*` 不会被展开（被当字面单元名），
    // 沙箱停不掉。故遍历本守卫登记的沙箱实例，按实际单元名逐个停。
    const insts = host.instances ? host.instances.all() : [];
    const sandboxes = insts.filter((i) => i.domain === 'sandbox' && i.id !== 'main');
    for (const inst of sandboxes) {
      let stopped = false;
      try {
        // 服务管理器抽象：编排层不直接调用 systemctl（跨平台）。
        // 仅当 stopUnit 明确返回 true 才认为单元已停；false/抛错两条失败路径都不得把实例谎报为 STOPPED。
        // ctx = 域门面推导的身份锚（端口/run.pid/cmdline）：systemd 档忽略之，portable 档无锚即无从归属、绝不能盲杀。
        stopped = platform.service.current().stopUnit('dsh-web@' + inst.id,
          Object.assign({ timeoutMs: 20000 }, host.instances.launchCtx(inst))) === true;
      } catch (e) { host.logger.warn && host.logger.warn('shutdownAll stop sandbox ' + inst.id + ': ' + (e && e.message)); }
      if (!stopped) {
        // 未确认停止：保留原 phase，不落 STOPPED（否则下次按错误相位决策形成 ghost）。
        host.logger.warn && host.logger.warn('shutdownAll stop sandbox ' + inst.id + ' 未确认停止，保留原 phase');
        host.events && host.events.append('shutdown_sandbox_stop_incomplete', { id: inst.id });
        continue;
      }
      try { if (inst.state) inst.state.phase = 'STOPPED'; } catch {}
    }
    if (sandboxes.length) { try { host.instances.save(); } catch {} }
}

module.exports = { shutdown, shutdownAll, _stopMainDsh, _stopAllSandboxes };
