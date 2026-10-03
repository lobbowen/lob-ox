'use strict';

const { semverCompare, VERSION_RE } = require('../../shared/version');

const TERMINAL_STATES = ['idle', 'done', 'failed'];

function busy(host) { return !TERMINAL_STATES.includes(host.upgradeState); }

// native 域的「忙/互斥」门禁（W1 单源）：install / upgrade / uninstall 三动作各自曾抄一遍
// 「任务忙 → 安装中 → 卸载中 → 升级中」四条判断（installer.js 3 处 + ops.js 3 处 = 6 处），
// 且 installer.upgrade 的次序与其余 5 处不同 ⇒ 「升级中 + 安装中」同时成立时给出的是**另一条**报错文案。
// 统一判定次序：任务忙 → 安装中 → 卸载中 → 升级中（= 6 处中 5 处的既有次序）。
// ⚠️ 次序差异只影响**文案**、不影响是否放行：installer.upgrade 原先把 upgradeState 排在 installing 之前，
//    故「升级中 + 安装中」同时成立时它报的是升级文案。统一后一律报安装文案（互斥结论相同：都是拒绝）。
// 返回 null = 放行；否则返回 { ok:false, error } 供调用方直接 return。
const BUSY_LABEL = {
  install:   { installing: '安装已在进行中', uninstalling: '卸载进行中，请稍后再装', busy: '升级进行中，请稍后再装' },
  upgrade:   { installing: '安装/升级已在进行中', uninstalling: '卸载进行中，请稍后再试', busy: '升级进行中' },
  uninstall: { installing: '安装进行中，无法卸载', uninstalling: '卸载已在进行中', busy: '升级进行中，无法卸载' },
};
function assertNotBusy(host, action) {
  const label = BUSY_LABEL[action] || BUSY_LABEL.install;
  if (host.tasks && host.tasks.isBusy('native', 'main')) return { ok: false, error: '已有任务在进行中' };
  if (host.installing) return { ok: false, error: label.installing };
  if (host.uninstalling) return { ok: false, error: label.uninstalling };
  if (busy(host)) return { ok: false, error: label.busy + '（state=' + host.upgradeState + '）' };
  return null;
}

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
  busy, assertNotBusy, upgradeBrief, versionInfo, isBareCommand,
  isValidVersion, isNewer, isUpToDate, needsRollback,
};
