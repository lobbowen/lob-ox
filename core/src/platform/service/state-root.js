'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SCHEMA = 1;

function root() {
  const override = process.env.DSH_SUPERVISOR_HOME;
  if (override && String(override).trim()) return path.resolve(String(override).trim());
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(local, 'dsh-supervisor');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'dsh-supervisor');
  }
  const xdg = process.env.XDG_STATE_HOME;
  return xdg && String(xdg).trim()
    ? path.join(String(xdg).trim(), 'dsh-supervisor')
    : path.join(os.homedir(), '.local', 'state', 'dsh-supervisor');
}

function supervisorDir() {
  return path.join(root(), 'supervisor');
}

function shellDir() {
  return path.join(root(), 'shell');
}

function legacySupervisorDir() {
  return path.join(os.homedir(), '.dsh', 'supervisor');
}
function legacyShellDir() {
  return path.join(os.homedir(), '.dsh', 'shell');
}

function why(e) { return ((e && e.code) ? e.code + ': ' : '') + ((e && e.message) || String(e)); }

function migrateLegacy() {
  const moved = [];
  const skipped = [];
  const failed = [];
  for (const [from, to] of [
    [legacySupervisorDir(), supervisorDir()],
    [legacyShellDir(), shellDir()],
  ]) {
    if (!fs.existsSync(from)) continue;
    try { fs.mkdirSync(to, { recursive: true }); } catch (e) { failed.push({ from, entry: null, error: why(e) }); continue; }
    let names = [];
    try { names = fs.readdirSync(from); } catch (e) { failed.push({ from, entry: null, error: why(e) }); continue; }
    for (const name of names) {
      const src = path.join(from, name);
      const dst = path.join(to, name);
      if (fs.existsSync(dst)) { skipped.push(src); continue; }
      try { fs.renameSync(src, dst); moved.push(src + ' -> ' + dst); } catch (e) { failed.push({ from, entry: name, error: why(e) }); }
    }
    try { if (fs.readdirSync(from).length === 0) fs.rmdirSync(from); } catch {  }
  }
  return { moved, skipped, failed };
}

module.exports = { SCHEMA, root, supervisorDir, shellDir, migrateLegacy };
