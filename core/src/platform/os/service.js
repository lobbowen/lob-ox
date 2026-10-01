'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const exec = require('../util/exec');
const input = require('../util/input');
const execPath = require('./exec-path');
const { portable } = require('./portable');

class CapabilityError extends Error {
  constructor(msg) { super(msg); this.name = 'CapabilityError'; this.code = 'CAPABILITY_UNSUPPORTED'; }
}

const PLATFORM = process.platform;

function run(cmd, args, opts) {
  // 统一执行器默认 15s 硬超时 + SIGKILL；必须原样透传 opts、不得强制 stdio ignore（isUnitActive 要读 stdout）。
  return exec.run(cmd, args, opts || {});
}

// unit 名白名单 fail-closed：inst.id 来自信任边界外，含 / .. 空白控制符即可把命令指向别的 .service。
const UNIT_NAME_RE = input.UNIT_NAME_RE;
function unitNameViolation(unit) { return input.unitNameViolation(unit); }

const systemd = {
  kind: 'systemd',
  supportsUnits: true,
  supportsTransient: true,
  daemonReload() { try { return run('systemctl', ['--user', 'daemon-reload'], { timeoutMs: 15000 }) !== null; } catch { return false; } },
  stopUnit(unit, opts) {
    if (unitNameViolation(unit)) return false;
    const o = opts || {};
    try { return run('systemctl', ['--user', 'stop', unit], { timeoutMs: o.timeoutMs || 15000 }) !== null; }
    catch { return false; }
  },
  resetFailed(unit) {
    if (unitNameViolation(unit)) return false;
    return run('systemctl', ['--user', 'reset-failed', unit], { timeoutMs: 10000 }) !== null;
  },
  isUnitActive(unit) {
    if (!unit) return true;
    if (unitNameViolation(unit)) return false;
    try {
      const r = exec.runDetail('systemctl', ['--user', 'is-active', unit], { timeoutMs: 8000 });
      if (r.timedOut) return null;
      const state = String(r.stdout || '').trim();
      if (state === 'active') return true;
      if (state || r.code !== null) return false;
      return null;
    } catch { return null; }
  },
  transientUnitFile(unit) {
    if (unitNameViolation(unit)) return null;
    let uid = 0;
    try { uid = os.userInfo().uid; } catch {  }
    const rt = process.env.XDG_RUNTIME_DIR || ('/run/user/' + uid);
    return path.join(rt, 'systemd', 'transient', unit + '.service');
  },
  cleanTransient(unit) {
    const errors = [];
    const bad = unitNameViolation(unit);
    if (bad) return { ok: false, errors: [bad] };
    exec.runDetail('systemctl', ['--user', 'stop', unit + '.service'], { timeoutMs: 10000 });
    exec.runDetail('systemctl', ['--user', 'reset-failed', unit + '.service'], { timeoutMs: 10000 });
    let unlinkOk = true;
    try { const f = this.transientUnitFile(unit); if (f) fs.unlinkSync(f); } catch { unlinkOk = false; errors.push('unlink ' + unit + '.service'); }
    if (!exec.runDetail('systemctl', ['--user', 'daemon-reload'], { timeoutMs: 15000 }).ok) errors.push('daemon-reload');
    return { ok: unlinkOk && errors.length === 0, errors };
  },
  startTransient(o) {
    const opts = o || {};
    const bad = unitNameViolation(opts.unit);
    if (bad) throw new Error('systemd-run 拒绝: ' + bad);
    const args = ['--user', '--unit=' + opts.unit];
    if (opts.description) args.push('--description=' + opts.description);
    for (const p of (opts.props || [])) args.push('--property=' + p);
    for (const [k, v] of Object.entries(opts.env || {})) args.push('--setenv=' + k + '=' + v);
    if (opts.workingDir) args.push('--working-directory=' + opts.workingDir);
    args.push('--', ...(opts.cmd || []));
    const r = exec.runDetail('systemd-run', args, { timeoutMs: opts.timeoutMs || 20000 });
    if (!r.ok) throw new Error('systemd-run 失败: ' + (r.error || 'unknown') + (r.stderr ? ' | ' + String(r.stderr).trim() : ''));
    return true;
  },
  setLimits(unit, alloc) {
    if (unitNameViolation(unit)) return false;
    const a = alloc || {};
    const props = [];
    if (a.memoryMax) props.push('MemoryMax=' + a.memoryMax);
    if (a.memoryHigh) props.push('MemoryHigh=' + a.memoryHigh);
    if (a.cpuQuota) props.push('CPUQuota=' + a.cpuQuota);
    if (!props.length) return false;
    return exec.runDetail('systemctl', ['--user', 'set-property', '--runtime', unit].concat(props),
      { timeoutMs: 10000 }).ok;
  },
};

function makeUnsupported(kind, label) {
  return {
    kind,
    supportsUnits: false,
    supportsTransient: false,
    daemonReload() { return false; },
    stopUnit() { throw new CapabilityError(label + '：不支持以用户单元方式管理被管实例'); },
    resetFailed() { return false; },
    isUnitActive(unit) { return unit ? false : true; },
    transientUnitFile() { return null; },
    cleanTransient() { return { ok: true, errors: [] }; },
    startTransient() { throw new CapabilityError(label + '：不支持拉起实例舱（portable 档未启用）'); },
    setLimits() { return false; },
  };
}

const NONE = makeUnsupported('none', '当前平台无服务管理器');

let _systemdRun = null;
function hasSystemdRun() {
  if (_systemdRun === null) {
    _systemdRun = !!execPath.resolveExecutable('systemd-run') ||
      exec.runOut('systemd-run', ['--version'], { timeoutMs: 3000 }) !== null;
  }
  return _systemdRun;
}

function current() {
  if (PLATFORM === 'linux') return hasSystemdRun() ? systemd : portable;
  if (PLATFORM === 'darwin' || PLATFORM === 'win32') return portable;
  return NONE;
}

module.exports = { current, CapabilityError, kind: () => current().kind, PLATFORM, UNIT_NAME_RE, unitNameViolation, _testProviders: { systemd, portable, NONE } };
