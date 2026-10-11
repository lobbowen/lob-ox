'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const execPath = require('../../platform/os/exec-path');
const policies = require('./policies');

function detected(host) {
  const cmd = Array.isArray(host.config.command) ? host.config.command : [];
  const configured = cmd[1];
  if (!policies.isBareCommand(configured)) {
    return { bin: configured, runtime: cmd[0] || null, isJs: /\.(js|cjs|mjs)$/i.test(configured) };
  }
  try { return execPath.resolveDsh({ npmRoot: host.npmRoot }); } catch { return null; }
}

function binPath(host) {
  const d = detected(host);
  if (d && d.bin) return d.bin;
  const bin = host.config.command && host.config.command[1];
  if (!bin) return null;
  return bin === '~' ? os.homedir() : (bin.startsWith('~/') ? path.join(os.homedir(), bin.slice(2)) : bin);
}

function readPkgVersion(file) {
  if (!fs.existsSync(file)) return null;
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (j.name) return String(j.version || '');
  } catch {}
  return null;
}

function versionNearBin(bin) {
  try {
    let dir = path.dirname(fs.realpathSync(bin));
    for (let i = 0; i < 8; i++) {
      const v = readPkgVersion(path.join(dir, 'package.json'));
      if (v !== null) return v;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {}
  return null;
}

function installedVersion(host) {
  const bin = binPath(host);
  if (!bin || !fs.existsSync(bin)) return null;
  return versionNearBin(bin);
}

function targetPort(config) {
  
  
  const direct = Number(config && config.targetPort);
  if (Number.isInteger(direct) && direct > 0) return direct;
  try { return Number(new URL(config.healthUrl).port) || null; } catch { return null; }
}

async function waitNativeHealthy(host, port, unit, timeoutMs) {
  if (!host.dist) return { ok: false, reason: 'dist 分发服务不可用' };
  return host.dist.waitPortHealthy({ host: '127.0.0.1', port, unit, timeoutMs });
}

function removableRoots(host) {
  return [host.dshHome, host.appHome, host.npmRoot].filter(Boolean);
}

function launcherSiblings(launcher) {
  if (!launcher) return [];
  const dir = path.dirname(launcher);
  const base = path.basename(launcher).replace(/\.(cmd|bat|ps1)$/i, "");
  const out = [];
  for (const ext of ["", ".cmd", ".bat", ".ps1"]) {
    const f = path.join(dir, base + ext);
    try { if (fs.existsSync(f)) out.push(f); } catch {}
  }
  return out;
}

function userDataPaths(host) {
  if (!host.dshHome) return [];
  return [
    path.join(host.dshHome, "sessions"),
    path.join(host.dshHome, "storages"),
    path.join(host.dshHome, "profiles"),
    path.join(host.dshHome, "settings.yaml"),
    path.join(host.dshHome, ".credentials.yaml"),
    path.join(host.dshHome, ".anonymous-user-id"),
  ];
}

function removalTargets(host) {
  const out = [];
  const push = (p) => { if (p && !out.includes(p)) out.push(p); };
  const d = detected(host);
  if (d && d.bin) push(d.bin);
  if (d && d.launcher) push(d.launcher);
  for (const s of launcherSiblings(d && d.launcher)) push(s);
  if (host.appHome) push(host.appHome);
  for (const p of userDataPaths(host)) push(p);
  return out;
}
module.exports = { detected, binPath, installedVersion, targetPort, waitNativeHealthy, removalTargets, removableRoots };
