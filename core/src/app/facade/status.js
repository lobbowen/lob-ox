'use strict';

const { installId } = require('../../platform/service/install-id');

function statusSummary(host) {
    const dshPidNow = host._mChild() ? host._mChild().pid : host._mAdoptPid();
    return {
      desired: host._mDesired(),
      phase: host._mPhase(),
      sessionState: host._sessionState,
      dataDirProtected: Array.isArray(host._fileProtectStatus)
        ? (host._fileProtectStatus.length > 0 && host._fileProtectStatus.every((r) => r.ok))
        : null,
      guardVersion: host.guardVersion,
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
