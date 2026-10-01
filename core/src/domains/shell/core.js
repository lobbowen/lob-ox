'use strict';

const DEFAULTS = {
  enabled: true,
  intervalMs: 20000,
  graceMs: 90000,
  updateGraceMs: 300000,
  maxRestarts: 5,
  windowMs: 1800000,
  phaseMaxAgeMs: 600000,
  procPattern: 'dsh-supervisor-gui',
};

const HEADLESS_FLAGS = Object.freeze([
  '--shell-update-plan', '--core-plan', '--node-plan', '--mirror-plan', '--env-plan',
  '--service-plan', '--platform-matrix', '--run-guard', '--watchdog',
]);
const HEADLESS_RE = new RegExp(HEADLESS_FLAGS.join('|'));

function isShellProcess(proc) {
  const c = String((proc && proc.cmdline) || '');
  if (HEADLESS_RE.test(c)) return false;
  return /dsh-supervisor-gui(\.exe)?/.test(c);
}

function decide(i) {
  const c = i.config || {};
  if (i.alive > 0) return { action: 'alive', reason: '壳在运行' };
  if (i.absentForMs === null || i.absentForMs === undefined) {
    return { action: 'record', reason: '首次观察到壳缺失，开始计时' };
  }
  const needMs = i.expectedAbsence
    ? (c.updateGraceMs || DEFAULTS.updateGraceMs)
    : (c.graceMs || DEFAULTS.graceMs);
  if (i.absentForMs < needMs) {
    return { action: 'wait', reason: i.expectedAbsence ? '壳处于预期缺席（更新/重启）' : '未达宽限期', needMs };
  }
  if (!i.sessionAvailable) {
    return { action: 'skip', reason: '无图形会话（注销/纯终端），拉起 GUI 必失败' };
  }
  if ((i.restartsInWindow || 0) >= (c.maxRestarts || DEFAULTS.maxRestarts)) {
    return { action: 'skip', reason: '窗口内拉起次数已达上限，停止重试（防风暴）' };
  }
  if (!i.hasExe) {
    return { action: 'skip', reason: '无法定位壳可执行文件（identity.json 未记录 exe）' };
  }
  return { action: 'restart', reason: '壳缺失且已过宽限期', needMs };
}

function isUpdatePhase(phase) {
  const p = String(phase || '');
  return p === 'restarting' || p.indexOf('shell-update') === 0;
}

function exeFromCmdline(cmdline) {
  const s = String(cmdline || '').trim();
  if (!s) return null;
  if (s.startsWith('"')) {
    const end = s.indexOf('"', 1);
    return end > 1 ? s.slice(1, end) : null;
  }
  return s.split(/\s+/)[0] || null;
}

function deriveState(id, journal) {
  const j = journal || {};
  if (!j.to) return { state: 'idle', reason: '无进行中的更新', journal: j, identity: id };

  const cur = id && id.version ? String(id.version) : null;

  if (cur && cur === j.to && id && id.phase === 'ready') {
    const next = j.confirmed === true ? j : Object.assign({}, j, { confirmed: true });
    return { state: 'confirmed', version: cur, reason: '壳已健康运行新版本', journal: next, identity: id };
  }

  return {
    state: 'pending',
    target: j.to, current: cur,
    reason: cur === j.to ? '等待壳上报就绪' : '等待壳重启到新版本',
    journal: j, identity: id,
  };
}

module.exports = { DEFAULTS, isShellProcess, decide, isUpdatePhase, exeFromCmdline, deriveState, HEADLESS_FLAGS };
