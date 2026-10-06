'use strict';

const stateRoot = require('../service/state-root');

const os = require('node:os');
const path = require('node:path');
const ex = require('../util/exec');
const execPath = require('./exec-path');
const desktop = require('./desktop');
const CAPABILITY_PROFILES = require('./capability-profile');
const environment = require('./environment');

// W6/单源：平台三态转调 shared/platform.js（此前本文件一份、sandbox.js 抄一份 ⇒ 同一事实两份）。
const { PLATFORM, ARCH, isLinux, isMac, isWindows } = require('../../shared/platform');

const _toolCache = {};
const _NEG_TTL_MS = 60000;
function hasTool(name, args) {
  const hit = _toolCache[name];
  if (hit !== undefined) {
    if (hit === true) return true;
    if (Date.now() - (hit.at || 0) < _NEG_TTL_MS) return false;
  }
  if (execPath.resolveExecutable(name)) { _toolCache[name] = true; return true; }
  const ok = ex.runOut(name, args || ['--version'], { timeoutMs: 3000 }) !== null;
  _toolCache[name] = ok ? true : { at: Date.now() };
  return ok;
}
function supervisorDir() {
  return stateRoot.supervisorDir();
}

function capabilityProfile(platform, arch) {
  const pl = platform || PLATFORM;
  const ar = arch || ARCH;
  const base = { platform: pl, arch: ar };
  if (pl === 'linux') return Object.assign(base, CAPABILITY_PROFILES.linux);
  if (pl === 'darwin') return Object.assign(base, CAPABILITY_PROFILES.darwin);
  if (pl === 'win32') return Object.assign(base, CAPABILITY_PROFILES.win32);
  return Object.assign(base, CAPABILITY_PROFILES.unknown);
}

function capabilities() {
  const p = capabilityProfile();
  const pl = p.platform;
  if (pl === 'linux') {
    p.sandboxLaunch = true;
    // ★ 服务管理器不借 OS 通道（唯一权威：STANDARDS.md）⇒ 不再有 cgroup 级强制，
    //   资源约束改由产品自身的监控与限流承担。如实声明为 supervise，不谎报 cgroup。
    p.sandboxEnforcement = 'supervise';
    p.desktopNotify = hasTool('notify-send');
    p.autostart = hasTool('systemctl');
    p.openBrowser = desktop.sessionAvailable();
  } else if (pl === 'darwin') {
    p.desktopNotify = hasTool('osascript');
  } else if (pl === 'win32') {
    p.processTreeKill = hasTool('taskkill');
    p.desktopNotify = hasTool('powershell');
    p.autostart = hasTool('schtasks');
  }
  return p;
}

environment.bind({ capabilities });

module.exports = {
  PLATFORM, ARCH, isLinux, isMac, isWindows,
  supervisorDir, capabilities, capabilityProfile, hasTool,
  processControl: require('./process'),
  pidlookup: require('./pidlookup'),
  execPath,
  fileProtect: require('./file-protect'),
  service: require('./service'),
  notify: require('./notify').notify,
  browser: require('./browser'),
  environment,
  desktop,
  autostart: require('./autostart'),
};
