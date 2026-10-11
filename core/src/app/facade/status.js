'use strict';

const { installId } = require('../../platform/service/install-id');

function deriveState(host) {
  const nat = host.nativeManager ? host.nativeManager.status() : null;
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
      native: host.nativeManager ? host.nativeManager.status() : null,
      version: host.nativeManager ? host.nativeManager.versionInfo() : null,
      upgrade: host.nativeManager ? host.nativeManager.upgradeBrief() : null,
      updatedAt: new Date().toISOString(),
    };
}

module.exports = { statusSummary };
