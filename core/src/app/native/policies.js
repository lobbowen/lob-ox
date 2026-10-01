'use strict';

const { semverCompare, VERSION_RE } = require('../../shared/version');

const TERMINAL_STATES = ['idle', 'done', 'failed'];

function busy(host) { return !TERMINAL_STATES.includes(host.upgradeState); }

function upgradeBrief(host) {
  return {
    state: host.upgradeState,
    targetVersion: host.targetVersion,
    startedAt: host.upgradeStartedAt,
    finishedAt: host.upgradeFinishedAt,
    lastError: host.upgradeError,
    rolledBack: host.rolledBack,
  };
}

function versionInfo(host, installedFallback) {
  const c = host.lastCheck || {};
  return {
    installed: c.installed || installedFallback || null,
    latest: c.latest || null,
    updateAvailable: !!c.updateAvailable,
    lastCheckAt: c.at || null,
    checking: host.checkingNow,
    error: c.error || null,
  };
}

function isBareCommand(configured) {
  return !configured
    || configured === 'dsh'
    || configured === 'dsh.cmd'
    || (!/[\\/]/.test(configured) && !String(configured).startsWith('~'));
}

function isValidVersion(version) { return !version || VERSION_RE.test(version); }

function isNewer(a, b) { return semverCompare(a, b) > 0; }

function isUpToDate(target, installed) { return semverCompare(target, installed) <= 0; }

function needsRollback(config, oldVersion, current) {
  return config.upgradeAutoRollback !== false && !!oldVersion && current !== null && current !== oldVersion;
}

module.exports = {
  busy, upgradeBrief, versionInfo, isBareCommand,
  isValidVersion, isNewer, isUpToDate, needsRollback,
};
