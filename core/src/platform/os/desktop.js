'use strict';

// 图形会话的唯一判定与补齐处：两件事共用同一份平台事实，谁都不许自己再摸一遍 socket。
//   1) 可用性 —— 守卫看护桌面壳前必须先确认有图形会话：无会话时拉起 GUI 必失败，
//      看护的周期重试会酿成重启风暴并掩盖真因。
//   2) 环境补齐 —— systemd --user 等语境不 import DISPLAY/WAYLAND_DISPLAY，此时要把真实
//      socket 位置补成环境变量交给 xdg-open（反代登录调浏览器走的就是这条路）。
// Linux 两件事都要实测（环境变量缺席不等于会话不存在）；
// darwin/win32 恒为可用且不补齐：守卫由图形会话内的 LaunchAgent / schtasks ONLOGON 载入，注销即随会话结束。

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const PLATFORM = process.platform;

const X11_DIR = '/tmp/.X11-unix';

/** 探测侧的依赖注入缝（行为测试不摸宿主 /tmp 与 /run，且能在任意宿主上穷举）。 */
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

/** X11 显示号（升序；编号小的即主会话）。目录不存在/无权 = 空集，不抛。 */
function x11Displays(o) {
  const d = deps(o);
  try {
    return d.readdir(X11_DIR).filter((f) => /^X\d+$/.test(f)).map((f) => Number(f.slice(1))).sort((a, b) => a - b);
  } catch { return []; }
}

/** Wayland socket 名（升序）。 */
function waylandSockets(o) {
  const d = deps(o);
  try {
    return d.readdir(runtimeDir(d.env, d.uid)).filter((f) => /^wayland-\d+$/.test(f)).sort();
  } catch { return []; }
}

function hasX11Socket(o) { return x11Displays(o).length > 0; }
function hasWaylandSocket(o) { return waylandSockets(o).length > 0; }

/** 补齐缺失的图形环境变量（只回「本语境缺、而 socket 实测在」的那几项）：
 *  已有值一律不覆盖 —— 用户/服务自己导出的 DISPLAY 就是他的意图。
 *  DBUS 与会话是否已在图形环境无关（xdg-open 的端口级私有地址常靠它），故单独判。 */
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
    return hasX11Socket() || hasWaylandSocket(); // 环境变量未 import 时的实测兜底
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
  // 必须委托 sessionAvailable()：此处若重写判定表达式，两份副本会漂移
  // （把 sessionAvailable 改成 false 后 describe 仍报可用，即此症）。
  return { platform: PLATFORM, available: sessionAvailable(),
           reason: 'session-scoped-by-launcher' };
}

module.exports = { sessionAvailable, sessionEnv, describe, x11Displays, waylandSockets, PLATFORM };
