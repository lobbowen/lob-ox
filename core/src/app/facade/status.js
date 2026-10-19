'use strict';

const { installId } = require('../../platform/service/install-id');
const pidlook = require('../../platform/os/pidlookup');

function deriveState(host) {
  const nat = host.nativeAgent ? host.nativeAgent.status() : null;
  if (nat && nat.installed === false) return "uninstalled";
  if (host._mMissingNotified && host._mMissingNotified()) return "command_missing";
  const ph = String(host._mPhase() || "").toUpperCase();
  if (ph === "RUNNING") return "running";
  if (ph === "STARTING") return "starting";
  if (ph === "FAILED") return "failed";
  return "stopped";
}

function statusSummary(host) {
    const dshPidNow = host._mChild() ? host._mChild().pid : host._mAdoptPid();
    return {
      desired: host._mDesired(),
      phase: host._mPhase(),
      state: deriveState(host),
      sessionState: (host.session ? host.session.state() : 'running'),
      dataDirProtected: Array.isArray(host._fileProtectStatus)
        ? (host._fileProtectStatus.length > 0 && host._fileProtectStatus.every((r) => r.ok))
        : null,
      guardVersion: host.guardVersion,
      installId: installId(),
      dshPid: dshPidNow,
      dshPort: dshPidNow ? (host.config.targetPort || null) : null,
      adopted: host._mAdopted(),
      // 观测未受管（第四种态）：adopted × observedOnly 组合出四态，单用 adopted 会漏 D 态。
      //   adopted=false, observedOnly=false ⇒ 内核自己 spawn 的（受管）
      //   adopted=true,  observedOnly=false ⇒ 认领来的（受管，S-7b 之后）
      //   adopted=true,  observedOnly=true  ⇒ 观测到但没接管（本字段）
      //   adopted=false, observedOnly=true  ⇒ 不可能（observedOnly 只在认领路径设）
      observedOnly: host._mObservedOnly ? host._mObservedOnly() === true : false,
      // spawn 冷静期截止时间戳（不是布尔）：product-manager 的 E2 判据要的是「还要等多久」，
      // 而布尔只能答「在不在冷静期」。三态必须可辨：null = 无冷静期；未到 = 冷静中；
      // 已过 = 已恢复 —— 把 null 与「已过」混为一谈会让面板显示「冷却 0 秒」。
      spawnBlockedUntil: host._mSpawnBlockedUntil ? (host._mSpawnBlockedUntil() || null) : null,
      // 目标端口当前是否被**非本产品**进程占用（三态）。
      //
      // 为什么要有这个状态字段（而不只靠 port_occupied_unhealthy 事件）：那个事件有 60s
      // 节流（runtime.js:230），它回答「发生过」；而交互判据要的是「现在是否」——
      // 用户点启动前要知道此刻端口通不通。事件与状态是两个问题。
      //
      // 为什么用同步探针（findListeningPid + isAlive）而不用 judgePort：`/status` 是同步
      // 出口（lifecycle.js:13 无 await），而 judgePort 带 timeout 是异步的。同步探针的
      // 代价是探测深度浅一档，故给出三态而不是二值——读不到就 null，不猜。
      //
      //   true  = 端口有人在听，且**不是**我们的 DSH（被占）
      //   false = 端口没人在听，或在听的是我们的 DSH
      //   null  = 探测不到（进程表读不出口令）
      portOccupied: (() => {
        try {
          const port = host.config && host.config.targetPort;
          if (!port) return null;
          const pid = pidlook.findListeningPid(port);
          if (!pid) return false;
          // isManagedProcess 挂在 host.main 上（collaborators.js:33 的 main 组），
          // 不在 host 顶层——首次写这儿时按 host.isManagedProcess 取，拿到 undefined
          // 而静默走 fallback ⇒ 真机 3080 上是我们的 DSH（7580）却报 null。
          const judge = host.main && host.main.isManagedProcess;
          if (typeof judge === 'function') {
            const ours = judge.call(host.main, pid);
            if (ours === null || ours === undefined) return null;
            return !ours;
          }
          return pidlook.isAlive(pid) ? null : false;
        } catch { return null; }
      })(),
      guardPid: process.pid,
      restartCount: host._mRestartCount(),
      startupFailWindowStart: host._mStartupFailWindowStart(),
      startupFailCount: host._mStartupFailCount(),
      lastFailure: host._mLastFailure(),
      lastRestartAt: host._mLastRestartAt(),
      shellHalted: host._shellHalted === true,
      commandMissing: !!(host._mMissingNotified && host._mMissingNotified()),
      dshTokenCaptured: !!(host.tokenService && host.tokenService.get('main')),
      tasks: host.tasks ? host.tasks.running().map((t) => ({ id: t.id, kind: t.kind, action: t.action, target: t.target, state: t.state })) : [],
      native: host.nativeAgent ? host.nativeAgent.status() : null,
      version: host.nativeAgent ? host.nativeAgent.versionInfo() : null,
      upgrade: host.nativeAgent ? host.nativeAgent.upgradeBrief() : null,
      updatedAt: new Date().toISOString(),
    };
}

module.exports = { statusSummary };
