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
  if (host.config.installedPkgJsonPath) {
    try {
      const j = JSON.parse(fs.readFileSync(host.config.installedPkgJsonPath, 'utf8'));
      if (j.name) return String(j.version || '');
    } catch { return null; }
  }
  const bin = binPath(host);
  if (!bin || !fs.existsSync(bin)) return null;
  return versionNearBin(bin);
}

function targetPort(config) {
  try { return Number(new URL(config.healthUrl).port) || null; } catch { return null; }
}

function mainUnit() { return null; }

async function waitNativeHealthy(host, port, unit, timeoutMs) {
  if (!host.dist) return { ok: false, reason: 'dist 分发服务不可用' };
  return host.dist.waitPortHealthy({ host: '127.0.0.1', port, unit, timeoutMs });
}

module.exports = { detected, binPath, installedVersion, targetPort, mainUnit, waitNativeHealthy };
