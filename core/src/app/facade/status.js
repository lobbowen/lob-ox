'use strict';

// app/facade/status.js —— 对外只读状态视图 statusSummary。
const { installId } = require('../../platform/service/install-id');

function statusSummary(host) {
    // 原生 DSH 端口自检测：端口是「实际运行态」属性，而非静态配置值——
    // 仅当目标在线（有 pid）时返回其实际监听端口，未启动/离线返回 null（前端显示横杠）。
    const dshPidNow = host._mChild() ? host._mChild().pid : host._mAdoptPid();
    return {
      desired: host._mDesired(),
      phase: host._mPhase(),
      // 会话生命周期（INV-S4）：与 phase 正交——phase 是 main 状态机相位，
      // sessionState 是整个服务链的运行相位（前端/壳据此表达「退出中/已退出」）。
      sessionState: host._sessionState,
      // 数据目录保护状态（Windows 无 icacls 时可观测降级）。
      dataDirProtected: Array.isArray(host._fileProtectStatus)
        ? (host._fileProtectStatus.length > 0 && host._fileProtectStatus.every((r) => r.ok))
        : null,
      guardVersion: host.guardVersion,
      // 安装标识：面板底部状态栏外显（运行状态之前），用户据此申请灰度。
      // 取不到时为 null —— 前端优雅降级，绝不伪造一个值（那会让灰度匹配到错的机器）。
      installId: installId(),
      dshPid: dshPidNow,
      dshPort: dshPidNow ? (host.config.targetPort || null) : null,
      adopted: host._mAdopted(),
      guardPid: process.pid,
      lastProbeAt: host._mLastProbeAt(),
      lastProbeOk: host._mLastProbeOk(),
      restartCount: host._mRestartCount(),
      crashWindowStart: host._mCrashWindowStart(),
      crashWindowRestarts: host._mCrashWindowRestarts(),
      backoffLevel: host._mBackoffLevel(),
      backoffUntil: host._mBackoffUntil(),
      lastFailure: host._mLastFailure(),
      lastRestartAt: host._mLastRestartAt(),
      upgradeHold: host._upgradeHold,
      // 用户退出标记（跨守卫重启持久）：退出后守卫重启不得凭看护把壳拉回。
      shellHalted: host._shellHalted === true,
      commandMissing: !!(host._mSpawnBlockedUntil() && Date.now() < host._mSpawnBlockedUntil()),
      dshTokenCaptured: !!(host.tokenService && host.tokenService.get('main')),
      tasks: host.tasks ? host.tasks.running().map((t) => ({ id: t.id, kind: t.kind, action: t.action, target: t.target, state: t.state })) : [],
      native: host.nativeManager ? host.nativeManager.status() : null,
      version: host.nativeManager ? host.nativeManager.versionInfo() : null,
      upgrade: host.nativeManager ? host.nativeManager.upgradeBrief() : null,
      updatedAt: new Date().toISOString(),
    };
}

module.exports = { statusSummary };
