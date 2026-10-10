'use strict';

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { resolveExecutable } = require('../exec-path');
const BRAND = require('../../../shared/brand');

const win32 = require('./win32');
const darwin = require('./darwin');
const linux = require('./linux');

const isLinux = process.platform === 'linux';
const isMac = process.platform === 'darwin';
const isWindows = process.platform === 'win32';

const CLI_EXE = isWindows ? BRAND.CLI_NAME + '.exe' : BRAND.CLI_NAME;
const GUI_EXE = isWindows ? BRAND.GUI_BIN_NAME + '.exe' : BRAND.GUI_BIN_NAME;

function daemonCommand() {
  const hit = resolveExecutable(BRAND.CLI_NAME, { envVar: BRAND.ENV_DAEMON });
  if (hit) return hit;
  return path.join(os.homedir(), '.local', 'bin', CLI_EXE);
}

function guiCommand() {
  const hit = resolveExecutable(BRAND.GUI_BIN_NAME, { envVar: BRAND.ENV_SHELL_EXE });
  if (hit) return hit;
  const home = os.homedir();
  const cands = isWindows
    ? [path.join(home, '.local', 'bin', GUI_EXE),
       path.join(home, 'AppData', 'Local', 'Programs', BRAND.PRODUCT_NAME, GUI_EXE)]
    : [path.join(home, '.local', 'bin', GUI_EXE), '/usr/local/bin/' + GUI_EXE, '/opt/homebrew/bin/' + GUI_EXE];
  for (const c of cands) { try { if (fs.statSync(c).isFile()) return c; } catch {} }
  return cands[0];
}

const DEPS = { guiCommand };

function status() {
  if (isWindows) return win32.status();
  if (isMac) { return darwin.status(); }
  if (!isLinux) return { kind: 'none', unit: 'unsupported', on: false, gui: false };
  return linux.status();
}

function setAutostart(on) {
  if (isWindows) return win32.setAutostart(on, DEPS);
  if (isMac) return darwin.setAutostart(on, DEPS);
  return linux.setAutostart(on, DEPS);
}

function setGuiAutostart(on, platform) {
  const pl = platform || process.platform;
  if (pl === 'darwin') return darwin.setGuiAutostart(on, DEPS);
  if (pl === 'win32') return win32.setGuiAutostart(on, DEPS);
  if (pl !== 'linux') return { ok: false, unsupported: true, platform: pl, enabled: false, error: '未知平台' };
  return linux.setGuiAutostart(on, DEPS);
}

module.exports = { status, setAutostart, setGuiAutostart, daemonCommand, guiCommand };
