'use strict';

// 平台化开机自启（三端同一 setAutostart(on) / status()）—— 门面。机制：Linux systemd --user enable/disable + linger
//   + XDG autostart；macOS launchctl bootstrap/bootout；Windows schtasks ONLOGON。外部命令一律经 platform/util/exec，
//   能力缺失返回明确错误绝不静默成功。内核绝不写/删 plist：壳启动会重建自己的定义并 bootstrap，unlink 表现为关闭不生效。

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { resolveExecutable } = require('../exec-path');

const win32 = require('./win32');
const darwin = require('./darwin');
const linux = require('./linux');

const isLinux = process.platform === 'linux';
const isMac = process.platform === 'darwin';
const isWindows = process.platform === 'win32';

/** 守护进程执行路径（自启/服务定义使用）。经 exec-path 跨平台解析；无命中时回退
 *  ~/.local/bin（Windows 带 .exe）。 */
function daemonCommand() {
  const hit = resolveExecutable('dsh-supervisor', { envVar: 'DSH_SUPERVISOR_DAEMON' });
  if (hit) return hit;
  const exe = isWindows ? 'dsh-supervisor.exe' : 'dsh-supervisor';
  return path.join(os.homedir(), '.local', 'bin', exe);
}

/** GUI 壳可执行路径（Windows watchdog 拉起面板用）。壳由 launcher 安装器部署，位置随安装
 *  方式而异：按 env 覆盖到常见安装位置解析。 */
function guiCommand() {
  const hit = resolveExecutable('dsh-supervisor-gui', { envVar: 'DSH_SHELL_EXE' });
  if (hit) return hit;
  const home = os.homedir();
  const exe = isWindows ? 'dsh-supervisor-gui.exe' : 'dsh-supervisor-gui';
  const cands = isWindows
    ? [path.join(home, '.local', 'bin', exe), path.join(home, 'AppData', 'Local', 'Programs', 'dsh-supervisor', exe)]
    : [path.join(home, '.local', 'bin', exe), '/usr/local/bin/' + exe, '/opt/homebrew/bin/' + exe];
  for (const c of cands) { try { if (fs.statSync(c).isFile()) return c; } catch {} }
  return cands[0];
}

const DEPS = { guiCommand };

/** 当前自启状态（三端同一 kind/on/gui 形态）。 */
function status() {
  if (isWindows) return win32.status();
  if (isMac) { return darwin.status(); }
  // 未知平台：显式 kind:'none' 且不触碰 systemctl（不产生误导性的 ENOENT 噪声）。
  if (!isLinux) return { kind: 'none', unit: 'unsupported', on: false, gui: false };
  return linux.status();
}

function setAutostart(on) {
  if (isWindows) return win32.setAutostart(on, DEPS);
  if (isMac) return darwin.setAutostart(on, DEPS);
  return linux.setAutostart(on, DEPS);
}

/** GUI（桌面壳）登录自启。三平台均已实现（win32 由 setAutostart 的 schtasks 承担）。 */
function setGuiAutostart(on, platform) {
  const pl = platform || process.platform;
  if (pl === 'darwin') return darwin.setGuiAutostart(on, DEPS);
  if (pl === 'win32') return win32.setGuiAutostart(on);
  if (pl !== 'linux') return { ok: false, unsupported: true, platform: pl, enabled: false, error: '未知平台' };
  return linux.setGuiAutostart(on, DEPS);
}

module.exports = { status, setAutostart, setGuiAutostart, daemonCommand, guiCommand };
