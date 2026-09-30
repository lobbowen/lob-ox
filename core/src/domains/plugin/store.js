'use strict';

const http = require('node:http');

// 插件域只读持久化 / 已装清单视图：profile/版本/manifest/home 补丁层/overlay 的只读读取，
// inventory 为运行态 HTTP RPC，listInstalled 聚合多目标（targets 由调用方解析后传入，本文件不
// require targets、不反向依赖 ops）。写路径（原子写+串行队列+scrub）在 layers.js，编排在 jobs.js/ops.js。

const fs = require('node:fs');
const path = require('node:path');
const { dirSizeBytes } = require('../../platform/util/fs');
const { PROTECTED, ownerPackage, targetHomePatchPath } = require('./model');

/** 读 profile package.json（失败返回空对象）。 */
function readProfile(profileDir) {
  try { return JSON.parse(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8')); } catch { return {}; }
}

/** 读某插件已装版本（无则 null）。 */
function pkgVersion(profileDir, name) {
  try { return JSON.parse(fs.readFileSync(path.join(profileDir, 'node_modules', name, 'package.json'), 'utf8')).version || null; }
  catch { return null; }
}

/** 读原生 profile manifest（与 readProfile 同一文件、同一语义，单一实现）。 */
function readManifest(profileDir) { return readProfile(profileDir); }

/** 读 home 补丁层（JSON；ENOENT 视为空；YAML 视为不可改写）。 */
function readHomePatch(target) {
  const file = targetHomePatchPath(target);
  let raw = null;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) {
    if (!e || e.code !== 'ENOENT') return { ok: false, error: '读取补丁层失败: ' + (e && e.message || e) };
    return { ok: true, entries: [], file };
  }
  try {
    const j = JSON.parse(raw);
    return { ok: true, entries: Array.isArray(j) ? j : [], file };
  } catch {
    return { ok: false, error: '补丁层为非 JSON 格式（用户 YAML），不做自动改写', file };
  }
}

/** 读 legacy overlay 条目（路径显式入参）。 */
function overlayEntries(overlayFile) {
  try { return JSON.parse(fs.readFileSync(overlayFile, 'utf8')); } catch { return []; }
}

/** 运行态 inventory RPC（只读；dshPort 显式入参）。 */
async function inventory(dshPort) {
  const payload = JSON.stringify({ type: 'client-request', rpcId: 'pm-' + Date.now(), method: 'pluginInventory/list', payload: { args: {} } });
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: dshPort, path: '/api/pluginInventory/list', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }, timeout: 5000 }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => {
        try { const j = JSON.parse(b); if (j.result && j.result.ok) resolve(j.result.value); else reject(new Error((j.result && j.result.error && j.result.error.message) || 'rpc failed')); }
        catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end(payload);
  });
}

/** 单目标已装插件（读盘聚合 bundles + dependencies）。 */
function installedOn(target, protectedSet = PROTECTED) {
  const profile = readProfile(target.profileDir);
  const bundles = (profile.dsh && profile.dsh.profile && profile.dsh.profile.bundles) || [];
  const deps = profile.dependencies || {};
  const names = new Set([...bundles, ...Object.keys(deps)]);
  const out = [];
  for (const name of names) {
    if (protectedSet.has(name)) continue;
    out.push({ name, version: pkgVersion(target.profileDir, name), source: deps[name] || name, bundle: bundles.includes(name) });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** 原生目标明细（inventory + overlay/patch 禁用判定）。 */
async function listInstalledNative(ctx, nativeTarget) {
  const manifest = readManifest(ctx.profileDir);
  const bundles = (manifest.dsh && manifest.dsh.profile && manifest.dsh.profile.bundles) || [];
  let invOk = true;
  let invEntries = [];
  try { const r = ((await ctx.inventory()) || {}); invEntries = r.entries || []; } catch { invOk = false; }
  const overlayIds = new Set(ctx.overlayEntries().map((e) => e.id));
  const nativeHomePatch = readHomePatch(nativeTarget);
  const homePatchIds = new Set(nativeHomePatch.ok ? nativeHomePatch.entries.filter((e) => e && e.disabled && typeof e.id === 'string').map((e) => e.id) : []);
  const rows = invEntries.map((e) => {
    const pkg = ownerPackage(e.moduleName, bundles);
    const isThird = !!pkg;
    const disabledByOverlay = overlayIds.has(e.entryId) || overlayIds.has(e.moduleName);
    const disabledByPatch = homePatchIds.has(e.entryId) || homePatchIds.has(e.moduleName);
    return { entryId: e.entryId, moduleName: e.moduleName, enabled: !disabledByOverlay && !disabledByPatch && !!e.enabled, baseDisabled: !e.enabled, fiberPhase: e.fiberPhase, tier: isThird ? 'third-party' : 'core', pkg: pkg || null, toggleable: isThird };
  });
  const builtinPkgs = [...new Set(rows.filter((r0) => r0.tier === 'core').map((r0) => r0.moduleName))];
  return {
    inventoryReachable: invOk,
    counts: { rows: rows.length, active: rows.filter((r0) => r0.fiberPhase === 'active').length, disabledBase: rows.filter((r0) => r0.baseDisabled).length, pkgs: builtinPkgs.length },
    rows,
    builtinBundles: bundles.filter((n) => PROTECTED.has(n)).map((n) => ({ name: n, readonly: true })),
    installationOwned: [...PROTECTED],
  };
}

/** 多目标已装清单视图（targets 由 ops 解析后传入）。 */
async function listInstalled(ctx, targets) {
  const nativeTarget = targets.find((t) => t.id === 'native') || ctx._nativeTarget();
  const nativeDetail = await listInstalledNative(ctx, nativeTarget);
  const byName = new Map();
  for (const t of targets) {
    for (const p of installedOn(t)) {
      if (!byName.has(p.name)) byName.set(p.name, { name: p.name, version: p.version, bundle: p.bundle, source: p.source, targets: [] });
      byName.get(p.name).targets.push(t.id);
    }
  }
  // enabled 计算：任一目标启用即视为启用。生效面 = bundles 加载层 + home 补丁层
  // 禁用行（DSH_HOME/cordis.patch.yml，热载）+ 原生 legacy overlay（迁移期兼容）。
  const overlayIds = new Set(ctx.overlayEntries().map((e) => e.id));
  const homePatchDisabledIds = (t) => {
    const hp = readHomePatch(t);
    const set = new Set();
    if (hp.ok) for (const e of hp.entries) if (e && typeof e === 'object' && e.disabled && typeof e.id === 'string') set.add(e.id);
    return set;
  };
  const isEnabledOn = (t, pname) => {
    const profile = readProfile(t.profileDir);
    const inBundles = ((profile.dsh && profile.dsh.profile && profile.dsh.profile.bundles) || []).includes(pname);
    if (!inBundles) return false;
    if (homePatchDisabledIds(t).has(pname)) return false;
    if (t.kind === 'native') {
      const shortName = pname.split('/').pop();
      if (overlayIds.has(pname) || overlayIds.has(shortName) || overlayIds.has('include:' + shortName)) return false;
    }
    return true;
  };
  const thirdParty = [...byName.values()]
    .map((x) => {
      const enabled = x.targets.some((tid) => {
        const t = targets.find((tt) => tt.id === tid);
        return t ? isEnabledOn(t, x.name) : false;
      });
      // size：取首个安装目标目录体积（近似同源；目录缺失时为 0）
      const firstTarget = targets.find((t) => t.id === x.targets[0]);
      const size = firstTarget && x.name
        ? dirSizeBytes(path.join(firstTarget.profileDir, 'node_modules', x.name))
        : 0;
      return { name: x.name, version: x.version, bundle: x.bundle, source: x.source, targets: x.targets, targetNames: x.targets.map((id) => (targets.find((t) => t.id === id) || {}).name || id), enabled, size };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  return {
    ok: true,
    auditVer: 'AV2',
    inventoryReachable: nativeDetail.inventoryReachable,
    profile: ctx.profileName,
    targets: targets.map((t) => ({ id: t.id, name: t.name, kind: t.kind })),
    counts: { ...nativeDetail.counts, targets: targets.length },
    rows: nativeDetail.rows,
    thirdParty,
    builtinBundles: nativeDetail.builtinBundles,
    installationOwned: nativeDetail.installationOwned,
  };
}

/** 补丁行 id 推导：包名边界匹配（相等 / 子路径 / 带版本），不用 includes。 */
class PluginStore {
  constructor({ getInventory }) { this._getInventory = getInventory; }

  async _patchEntryIdsForPlugin(target, name) {
    const ids = new Set([name]); // 包名兜底（bundle 插件的 loader entry id）
    if (target.kind === 'native') {
      try {
        const entries = ((await this._getInventory()) || {}).entries || [];
        for (const e of entries) {
          const mn = String(e.moduleName || '');
          // 包名边界匹配：相等、以 <name>/ 开头（子路径）或以 <name>@ 开头（带版本）。
          // 明确排除 -/. 等可延长包名的字符，否则 dsh-tool 会吞掉 dsh-tool-extra。
          if (mn === name || mn.startsWith(name + '/') || mn.startsWith(name + '@')) ids.add(e.entryId);
        }
      } catch {}
    }
    return [...ids];
  }
}

module.exports = {
  readProfile, readManifest, readHomePatch, overlayEntries, inventory,
  installedOn, listInstalled, PluginStore,
};
