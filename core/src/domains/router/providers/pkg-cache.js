'use strict';

// npm 包缓存定位与预取（IO 叶子）。缓存根目录是平台事实，经 npx-forms#npxCacheDir 单源取得
// （CP-1）；本模块只做缓存 bin 定位/失效清理/npx 预下载，绝不自行拼 ~/.npm/_npx。

const path = require('node:path');
const fs = require('node:fs');
// 异步子进程必须走统一有界封装（裸 execFile 无 windowsHide，
// Windows 上 .cmd 垫片既弹控制台又触发无 shell spawn EINVAL）。
const ex = require('../../../platform/util/exec');
const { npxCacheDir, npxLauncher } = require('../../../platform/os/npx-forms');
const registryRef = require('../../../platform/distribution/registry-ref');

const HASH_DIR_RE = /^[0-9a-f]{8,}$/i;

/** 列出含 pkg 的缓存哈希目录（绝对路径）。 */
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

/** 定位已缓存的包 bin（<npxCacheDir>/<hash>/node_modules/<pkg>，按目录 mtime 取最新）。无则 null。 */
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

/** 清除含 pkg 的 npx 缓存哈希目录（强制重新拉取最新版）。返回删除数。 */
function invalidatePkgCache(pkg) {
  let removed = 0;
  for (const dir of pkgCacheDirs(pkg)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); removed++; } catch {}
  }
  return removed;
}

/** 下载预取：缓存未命中 -> npx --yes 预下载（首次安装）。 */
async function ensurePkgCached(provider, app) {
  if (!app || !app.pkg) return { ok: true };
  if (cachedPkgBin(app.pkg)) return { ok: true, cached: true };
  try {
    const regOrigin = provider.dist ? await provider.dist.registryOrigin(false).catch(() => null) : null;
    const env = Object.assign({}, process.env);
    // 注入走 registry-ref 单口：非法基址一律不写键（npx 会用自身默认源），
    // 成败以下方缓存复检为准，别让一个畸形地址伪装成「下载失败」。
    const rp = registryRef.registryEnvPair(regOrigin);
    if (rp.ok) Object.assign(env, rp.env);
    const launcher = npxLauncher();
    // 预下载成败以下方缓存复检为准，runOutAsync 自身绝不 reject。
    await ex.runOutAsync(launcher.program, [...launcher.args, '--yes', app.pkg, '--help'], { env, timeoutMs: 120000 });
    return { ok: !!cachedPkgBin(app.pkg) };
  } catch { return { ok: false }; }
}

module.exports = { cachedPkgBin, invalidatePkgCache, ensurePkgCached };
