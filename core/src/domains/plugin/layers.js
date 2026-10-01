'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { writeAtomic } = require('../../platform/util/fs');
const { readProfile, readHomePatch } = require('./store');
const { isProtectedName, isOwnRow, isOwnDisabled, targetHomePatchPath } = require('./model');

function createLayers({ overlayFile, logger }) {
  let queue = Promise.resolve();

  const enqueue = (tag, fn) => {
    const run = queue.then(fn);
    queue = run.catch(() => {});
    return run.catch((e) => {
      const msg = (e && e.message) || String(e);
      if (logger && logger.error) logger.error('[plugins] 补丁层写失败(' + tag + '): ' + msg);
      return { ok: false, error: msg };
    });
  };

  const removeFromProfileBundles = (target, pluginName) => {
    const profilePath = path.join(target.profileDir, 'package.json');
    const profile = readProfile(target.profileDir);
    const bundles = (profile.dsh && profile.dsh.profile && profile.dsh.profile.bundles) || [];
    if (!bundles.includes(pluginName)) return false;
    const nextBundles = bundles.filter((b) => b !== pluginName);
    profile.dsh = profile.dsh || {};
    profile.dsh.profile = profile.dsh.profile || {};
    profile.dsh.profile.bundles = nextBundles;
    // 原子写：裸 writeFileSync 在并发/中断下可能撕裂 package.json，且默认 umask 可能世界可读。
    writeAtomic(profilePath, JSON.stringify(profile, null, 2) + '\n', { mode: 0o600 });
    return true;
  };

  const writeHomePatch = (target, entries) => {
    const file = targetHomePatchPath(target);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeAtomic(file, JSON.stringify(entries, null, 2) + '\n', { mode: 0o600 });
    return file;
  };

  const saveOverlayEntries = (entries) => {
    fs.mkdirSync(path.dirname(overlayFile), { recursive: true });
    writeAtomic(overlayFile, JSON.stringify(entries, null, 2), { mode: 0o600 });
  };

  const scrubPluginLayersInner = async (ctx, target, name, onLog) => {
    const log = (m) => { try { if (typeof onLog === 'function') onLog(m); } catch {} };
    const findings = { cleaned: [], warnings: [] };
    try {
      const hp = readHomePatch(target);
      if (hp.ok) {
        const before = hp.entries.length;
        const after = hp.entries.filter((e) => {
          if (!e || typeof e !== 'object') return true;
          if (e.id === name) return false;
          if (Array.isArray(e.insert)) return !e.insert.some((r) => r && r.name === name);
          return true;
        });
        if (after.length !== before) {
          writeHomePatch(target, after);
          findings.cleaned.push('home 补丁层');
          log('已清理 home 补丁层残留（' + (before - after.length) + ' 条）');
        }
      } else {
        findings.warnings.push(hp.error);
        log(hp.error);
      }
      if (target.kind === 'native') {
        const shortName = name.split('/').pop();
        const before = ctx.overlayEntries();
        const list = before.filter((e) => e.id !== name && e.id !== 'include:' + shortName && e.id !== shortName);
        if (list.length !== before.length) {
          ctx.saveOverlayEntries(list);
          findings.cleaned.push('原生 overlay');
          log('已清理原生 overlay 残留');
        }
      }
      {
        const file = path.join(target.profileDir, 'cordis.patch.yml');
        let raw = null;
        try { raw = fs.readFileSync(file, 'utf8'); } catch {}
        if (raw) {
          let cleaned = false;
          try {
            const j = JSON.parse(raw);
            if (Array.isArray(j)) {
              const after = j.filter((e) => {
                if (!e || typeof e !== 'object') return true;
                if (e.id === name) return false;
                if (Array.isArray(e.insert)) return !e.insert.some((r) => r && r.name === name);
                return true;
              });
              if (after.length !== j.length) {
                fs.mkdirSync(path.dirname(file), { recursive: true });
                writeAtomic(file, JSON.stringify(after, null, 2) + '\n', { mode: 0o600 });
                cleaned = true;
                findings.cleaned.push('profile 补丁层');
                log('已清理 profile 补丁层残留');
              }
            }
          } catch {
            if (raw.includes(name)) {
              const msg = 'profile 补丁层（cordis.patch.yml）仍引用 ' + name + '：为避免下次启动装配失败，请手动移除相关 insert/include 行';
              findings.warnings.push(msg);
              log('⚠ ' + msg);
            }
          }
          if (!cleaned && !findings.warnings.length) log('profile 补丁层无该插件引用');
        }
      }
    } catch (e) {
      log('补丁层清理失败: ' + (e && e.message || e));
      findings.warnings.push('补丁层清理失败: ' + (e && e.message || e));
    }
    return findings;
  };

  const applyBundleEnabled = async (ctx, name, on, targetStr) => {
    if (isProtectedName(name)) return { ok: false, error: '内置组件不可变更' };
    if (!name) return { ok: false, error: 'missing plugin name' };
    let targets = [];
    if (targetStr && targetStr !== 'native') {
      const r = ctx.resolveTargets(targetStr);
      if (!r.ok) return r;
      targets = r.targets;
    } else {
      targets = [ctx._nativeTarget()];
    }
    const results = [];
    for (const target of targets) {
      const notes = [];
      const isInstalled = ctx.installedOn(target).some((p) => p.name === name);
      if (!isInstalled) {
        notes.push('该目标未安装，跳过');
        results.push({ id: target.id, name: target.name, changed: false, hot: false, notes });
        continue;
      }
      const ids = await ctx.store._patchEntryIdsForPlugin(target, name);
      const hp = readHomePatch(target);
      if (!hp.ok) {
        notes.push(hp.error);
        results.push({ id: target.id, name: target.name, changed: false, hot: false, notes });
        continue;
      }
      let changed = false;
      if (!on) {
        const before = JSON.stringify(hp.entries);
        const next = hp.entries.map((e) => (isOwnRow(e, ids) ? { ...e, disabled: true } : e));
        for (const id of ids) if (!next.some((e) => e.id === id)) next.push({ id, disabled: true });
        changed = JSON.stringify(next) !== before;
        if (changed) writeHomePatch(target, next);
        else notes.push('已在禁用态，无变更');
        if (changed) notes.push('已写补丁层禁用（' + ids.length + ' 个 entry）');
      } else {
        const before = JSON.stringify(hp.entries);
        const next = hp.entries.filter((e) => !isOwnDisabled(e, ids));
        changed = JSON.stringify(next) !== before;
        if (changed) writeHomePatch(target, next);
        else notes.push('本未禁用，无变更');
        if (target.kind === 'native') {
          const ovBefore = ctx.overlayEntries();
          const ovJson = JSON.stringify(ovBefore);
          const shortName = name.split('/').pop();
          const list = ovBefore.filter((e) => !ids.includes(e && e.id) && e.id !== 'include:' + shortName && e.id !== shortName);
          if (JSON.stringify(list) !== ovJson) {
            ctx.saveOverlayEntries(list);
            changed = true;
            notes.push('已清理 legacy overlay 禁用行');
          }
        }
      }
      if (ctx._targetRunning(target)) notes.push('运行中：补丁层热应用，即时生效（无需重启）');
      else notes.push('未运行：已写入补丁层，下次启动生效');
      if (ctx.events) ctx.events.append(on ? 'plugin_enabled' : 'plugin_disabled', { name, target: target.id, entries: ids.length, hot: true, changed, running: ctx._targetRunning(target) });
      results.push({ id: target.id, name: target.name, changed, hot: true, ids, notes });
    }
    const rows = results.filter((r) => r.changed).length;
    return { ok: true, rows, results };
  };

  return {
    enqueue,
    removeFromProfileBundles,
    writeHomePatch,
    saveOverlayEntries,
    scrubPluginLayersInner,
    applyBundleEnabled,
  };
}

module.exports = { createLayers };
