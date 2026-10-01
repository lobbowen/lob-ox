'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { writeAtomic } = require('../../platform/util/fs');
const probe = require('./probe');

function read(host) {
  try { return JSON.parse(fs.readFileSync(host.manifestFile, 'utf8')); } catch { return null; }
}

function save(host, m) {
  try {
    fs.mkdirSync(host.stateDir, { recursive: true });
    const f = host.manifestFile;
    fs.mkdirSync(path.dirname(f), { recursive: true });
    writeAtomic(f, JSON.stringify(m, null, 2), { mode: 0o600 });
  } catch (e) { host.logger.warn && host.logger.warn('manifest 保存失败: ' + e.message); }
}

function record(host, version, dataPaths, npmRoot) {
  let claim = Array.isArray(dataPaths) ? dataPaths : null;
  if (claim === null) {
    const prev = read(host);
    if (prev && Array.isArray(prev.dataPaths)) claim = prev.dataPaths;
  }
  const bin = probe.binPath(host);
  const pkgDir = npmRoot ? path.join(npmRoot, host.config.packageName || '@deepseek-ai/dsh') : null;
  save(host, {
    installedAt: new Date().toISOString(),
    version,
    binPath: bin || null,
    npmRoot: npmRoot || null,
    packageDir: pkgDir,
    dshHome: host.dshHome,
    dataPaths: claim || [],
  });
}

function claimDataPaths(host) {
  const paths = [
    path.join(host.dshHome, 'sessions'),
    path.join(host.dshHome, 'storages'),
    path.join(host.dshHome, 'profiles'),
    path.join(host.dshHome, 'settings.yaml'),
    path.join(host.dshHome, '.credentials.yaml'),
    path.join(host.dshHome, '.anonymous-user-id'),
  ];
  for (const p of paths) {
    try { if (fs.existsSync(p)) return []; } catch { return []; }
  }
  return paths;
}

module.exports = { read, save, record, claimDataPaths };
