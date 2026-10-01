'use strict';

const path = require('node:path');
const fs = require('node:fs');
const ex = require('../../../platform/util/exec');
const { npxCacheDir, npxLauncher } = require('../../../platform/os/npx-forms');
const registryRef = require('../../../platform/distribution/registry-ref');

const HASH_DIR_RE = /^[0-9a-f]{8,}$/i;

function pkgCacheDirs(pkg) {
  if (!pkg) return [];
  const out = [];
  try {
    const npxDir = npxCacheDir();
    if (!fs.existsSync(npxDir)) return out;
    for (const d of fs.readdirSync(npxDir)) {
      if (!HASH_DIR_RE.test(d)) continue;
      if (fs.existsSync(path.join(npxDir, d, 'node_modules', pkg))) out.push(path.join(npxDir, d));
    }
  } catch {}
  return out;
}

function cachedPkgBin(pkg) {
  if (!pkg) return null;
  let dirs = [];
  try {
    const npxDir = npxCacheDir();
    if (!fs.existsSync(npxDir)) return null;
    dirs = fs.readdirSync(npxDir).filter((d) => HASH_DIR_RE.test(d));
    dirs.sort((a, b) => { try { return fs.statSync(path.join(npxDir, b)).mtimeMs - fs.statSync(path.join(npxDir, a)).mtimeMs; } catch { return 0; } });
    for (const d of dirs) {
      const pkgDir = path.join(npxDir, d, 'node_modules', pkg);
      if (!fs.existsSync(pkgDir)) continue;
      try {
        const j = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
        const bin = j.bin;
        let rel = null;
        if (typeof bin === 'string') rel = bin;
        else if (bin && typeof bin === 'object') { const k = Object.keys(bin)[0]; rel = bin[k]; }
        if (rel) return path.join(pkgDir, rel);
      } catch {}
    }
  } catch {}
  return null;
}

function invalidatePkgCache(pkg) {
  let removed = 0;
  for (const dir of pkgCacheDirs(pkg)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); removed++; } catch {}
  }
  return removed;
}

async function ensurePkgCached(provider, app) {
  if (!app || !app.pkg) return { ok: true };
  if (cachedPkgBin(app.pkg)) return { ok: true, cached: true };
  try {
    const regOrigin = provider.dist ? await provider.dist.registryOrigin(false).catch(() => null) : null;
    const env = Object.assign({}, process.env);
    const rp = registryRef.registryEnvPair(regOrigin);
    if (rp.ok) Object.assign(env, rp.env);
    const launcher = npxLauncher();
    await ex.runOutAsync(launcher.program, [...launcher.args, '--yes', app.pkg, '--help'], { env, timeoutMs: 120000 });
    return { ok: !!cachedPkgBin(app.pkg) };
  } catch { return { ok: false }; }
}

module.exports = { cachedPkgBin, invalidatePkgCache, ensurePkgCached };
