'use strict';

// 域：原生 DSH（app/native）—— 纯策略（无 fs / 无进程 / 无网络）。
// 全部零副作用，可独立 require 单测；只依赖 shared/version（纯）。

const { semverCompare, VERSION_RE } = require('../../shared/version');

/** 升级状态机的终态（其余状态视为「忙」）。 */
const TERMINAL_STATES = ['idle', 'done', 'failed'];

function busy(host) { return !TERMINAL_STATES.includes(host.upgradeState); }

/** 升级状态简报（不含日志）。 */
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

/** 版本信息视图：已装/最新/可更新/检查时间。installedFallback 由调用方（IO）提供。 */
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

/** 裸名判定：未配置 / 'dsh' / 'dsh.cmd' / 非路径且非 ~ 开头则需跨平台解析。 */
function isBareCommand(configured) {
  return !configured
    || configured === 'dsh'
    || configured === 'dsh.cmd'
    || (!/[\\/]/.test(configured) && !String(configured).startsWith('~'));
}

/** 版本号合法性（空值视为「取最新」，合法）。 */
function isValidVersion(version) { return !version || VERSION_RE.test(version); }

function isNewer(a, b) { return semverCompare(a, b) > 0; }

function isUpToDate(target, installed) { return semverCompare(target, installed) <= 0; }

/** 升级失败后是否需回滚：自动回滚开启 + 有旧版本 + 磁盘版本存在且已变。 */
function needsRollback(config, oldVersion, current) {
  return config.upgradeAutoRollback !== false && !!oldVersion && current !== null && current !== oldVersion;
}

module.exports = {
  busy, upgradeBrief, versionInfo, isBareCommand,
  isValidVersion, isNewer, isUpToDate, needsRollback,
};
