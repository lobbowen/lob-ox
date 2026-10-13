'use strict';

// agent 状态判定（纯函数层）。
//
// 从原生实现的状态判定收拢而来。原实现全部以 host（NativeManager 实例）
// 为入参，读取 host.upgradeState / host.lastCheck 等过程式字段——那只能服务原生形态。
// 本模块把判定**从 host 上剥离**，入参改为显式的状态对象，两种形态共用。
//
// 这是五件套里唯一可以完全纯化的部分：它不碰 IO、不碰进程，只回答
// 「忙不忙 / 版本关系 / 该不该回滚」这类问题。故放在 model 同级而非 ops 之下。

const { semverCompare, VERSION_RE } = require('../../shared/version');

// 终态集合：这三个之外的 upgradeState 都视为「有事在做」。
const TERMINAL_STATES = ['idle', 'done', 'failed'];

// 动作互斥文案：同一时刻只能有一个动作在跑。
// 原实现把这张表写在 policies.js 里，本模块保留但入参显式化。
const BUSY_LABEL = {
  install:   { installing: '安装已在进行中', uninstalling: '卸载进行中，请稍后再装', busy: '升级进行中，请稍后再装' },
  upgrade:   { installing: '安装/升级已在进行中', uninstalling: '卸载进行中，请稍后再试', busy: '升级进行中' },
  uninstall: { installing: '安装进行中，无法卸载', uninstalling: '卸载已在进行中', busy: '升级进行中，无法卸载' },
};

// state 形如 { upgradeState, installing, uninstalling, taskBusy }。
// taskBusy 由调用方从任务注册表取（本模块不依赖 tasks 服务，保持纯化）。
// 缺省（upgradeState 缺失）按「空闲」处理，不是「忙」。
// 原实现读 host.upgradeState，而 NativeManager 构造时初始化为 'idle'，
// 所以不会触发；纯函数版没有那个构造器，若把 undefined 当忙，
// 任何没初始化 state 的调用方都会被永久拒绝（卸载/安装/升级全走不动）。
function busy(state) {
  const s = state || {};
  const phase = s.upgradeState;
  if (phase === undefined || phase === null) return false;
  return !TERMINAL_STATES.includes(phase);
}

function assertNotBusy(state, action) {
  const s = state || {};
  const label = BUSY_LABEL[action] || BUSY_LABEL.install;
  if (s.taskBusy) return { ok: false, error: '已有任务在进行中' };
  if (s.installing) return { ok: false, error: label.installing };
  if (s.uninstalling) return { ok: false, error: label.uninstalling };
  if (busy(s)) return { ok: false, error: label.busy + '（state=' + s.upgradeState + '）' };
  return null;
}

// 升级进度摘要：字段名与原 upgradeBrief 一致，UI 无需改。
function upgradeBrief(state) {
  const s = state || {};
  return {
    state: s.upgradeState,
    targetVersion: s.targetVersion,
    startedAt: s.upgradeStartedAt,
    finishedAt: s.upgradeFinishedAt,
    lastError: s.upgradeError,
    rolledBack: s.rolledBack,
  };
}

// 版本信息投影：installed 可回退（探不到磁盘版本时用上次记录值）。
function versionInfo(state, installedFallback) {
  const c = (state && state.lastCheck) || {};
  return {
    installed: c.installed || installedFallback || null,
    latest: c.latest || null,
    updateAvailable: !!c.updateAvailable,
    lastCheckAt: c.at || null,
    checking: state && state.checkingNow,
    error: c.error || null,
  };
}

// 裸命令判定：command 是否只是「dsh」这种依赖 PATH 的形式。
// 原实现硬编码 'dsh'/'dsh.cmd'——本模块保留该判定，但**不假设 agent 产品名**：
// 判据是「不含路径分隔且不以 ~ 开头」，与具体叫什么无关。
function isBareCommand(configured) {
  if (!configured) return true;
  if (/[/\\]/.test(String(configured))) return false;
  if (String(configured).startsWith('~')) return false;
  return true;
}

function isValidVersion(version) { return !version || VERSION_RE.test(version); }

function isNewer(a, b) { return semverCompare(a, b) > 0; }

function isUpToDate(target, installed) { return semverCompare(target, installed) <= 0; }

// 是否该回滚：显式开启 + 有旧版本 + 当前版本与旧版本不同。
function needsRollback(config, oldVersion, current) {
  return config.upgradeAutoRollback !== false && !!oldVersion && current !== null && current !== oldVersion;
}

module.exports = {
  TERMINAL_STATES, BUSY_LABEL,
  busy, assertNotBusy, upgradeBrief, versionInfo, isBareCommand,
  isValidVersion, isNewer, isUpToDate, needsRollback,
};