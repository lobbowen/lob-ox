'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const BRAND = require('../../shared/brand');

const SCHEMA = 1;

function root() {
  const override = process.env[BRAND.ENV_STATE_ROOT];
  if (override && String(override).trim()) return path.resolve(String(override).trim());
  return BRAND.stateRoot(process.platform, process.env, os.homedir());
}

function supervisorDir() {
  return path.join(root(), BRAND.STATE_SUPERVISOR_SUBDIR);
}

function shellDir() {
  return path.join(root(), BRAND.STATE_SHELL_SUBDIR);
}

function legacySupervisorDir() {
  return path.join(os.homedir(), BRAND.LEGACY_HARNESS_DIR, BRAND.STATE_SUPERVISOR_SUBDIR);
}
function legacyShellDir() {
  return path.join(os.homedir(), BRAND.LEGACY_HARNESS_DIR, BRAND.STATE_SHELL_SUBDIR);
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
