'use strict';

// 无图形会话时拉起 GUI 必失败（周期重试会酿成重启风暴）；systemd --user 不 import DISPLAY/WAYLAND_DISPLAY，须按实测 socket 补齐。

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const PLATFORM = process.platform;

const X11_DIR = '/tmp/.X11-unix';

function deps(o) {
  const ov = o || {};
  return {
    env: ov.env || process.env,
    readdir: ov.readdir || ((p) => fs.readdirSync(p)),
    exists: ov.exists || ((p) => fs.existsSync(p)),
    home: ov.home || os.homedir(),
    uid: typeof process.getuid === 'function' ? process.getuid() : 0,
  };
}

function runtimeDir(env, uid) { return env.XDG_RUNTIME_DIR || ('/run/user/' + uid); }

function x11Displays(o) {
  const d = deps(o);
  try {
    return d.readdir(X11_DIR).filter((f) => /^X\d+$/.test(f)).map((f) => Number(f.slice(1))).sort((a, b) => a - b);
  } catch { return []; }
}

function waylandSockets(o) {
  const d = deps(o);
  try {
    return d.readdir(runtimeDir(d.env, d.uid)).filter((f) => /^wayland-\d+$/.test(f)).sort();
  } catch { return []; }
}

function hasX11Socket(o) { return x11Displays(o).length > 0; }
function hasWaylandSocket(o) { return waylandSockets(o).length > 0; }

function sessionEnv(o) {
  const d = deps(o);
  const out = {};
  if (PLATFORM !== 'linux') return out;
  if (!d.env.DISPLAY && !d.env.WAYLAND_DISPLAY) {
    const xs = x11Displays(d);
    if (xs.length) {
      out.DISPLAY = ':' + xs[0];
      const xauth = path.join(d.home, '.Xauthority');
      if (d.exists(xauth)) out.XAUTHORITY = xauth;
    } else {
      const wl = waylandSockets(d);
      if (wl.length) out.WAYLAND_DISPLAY = wl[0];
    }
  }
  if (!d.env.DBUS_SESSION_BUS_ADDRESS) {
    const bus = path.join(runtimeDir(d.env, d.uid), 'bus');
    if (d.exists(bus)) out.DBUS_SESSION_BUS_ADDRESS = 'unix:path=' + bus;
  }
  return out;
}

function sessionAvailable() {
  if (PLATFORM === 'linux') {
    if (process.env.DISPLAY || process.env.WAYLAND_DISPLAY) return true;
    return hasX11Socket() || hasWaylandSocket();
  }
  return PLATFORM === 'darwin' || PLATFORM === 'win32';
}

function describe() {
  if (PLATFORM === 'linux') {
    const byEnv = !!(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
    const byX = hasX11Socket();
    const byWl = hasWaylandSocket();
    return {
      platform: PLATFORM,
      available: byEnv || byX || byWl,
      reason: byEnv ? 'env(DISPLAY/WAYLAND_DISPLAY)' : (byX ? 'x11-socket' : (byWl ? 'wayland-socket' : 'none')),
      display: process.env.DISPLAY || null,
      waylandDisplay: process.env.WAYLAND_DISPLAY || null,
    };
  }
  return { platform: PLATFORM, available: sessionAvailable(),
           reason: 'session-scoped-by-launcher' };
}

module.exports = { sessionAvailable, sessionEnv, describe, x11Displays, waylandSockets, PLATFORM };
