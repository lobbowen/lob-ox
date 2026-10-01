'use strict';

const fs = require('node:fs');
const ports = require('../../platform/service/ports').shared;
const { remoteTokenStrength } = require('../../shared/credential');
const model = require('./model');
const sandbox = require('./sandbox');

function createOps(deps) {
  const { store, lifecycle, upgrade, service, logger, events, tokens, tasks, hooks, instancesRoot, dshBin } = deps;
  let timer = null;

  function list() {
    return store.instances.map((inst) => {
      const info = upgrade.versionInfo(inst);
      return model.viewRow(inst, {
        version: info.version,
        latest: info.latest,
        updateJob: upgrade.jobView(inst),
        probe: lifecycle.probe(inst),
      });
    });
  }

  async function addInstance(payload) {
    const port = parseInt(payload.port, 10);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) return { ok: false, error: '无效端口' };
    if (store.instances.some((i) => i.port === port)) return { ok: false, error: '端口 ' + port + ' 已被实例占用' };
    const tk = String(payload.remoteToken || '');
    if (tk && !remoteTokenStrength(tk).ok) return { ok: false, error: '远程访问令牌（remoteToken）至少 8 位' };
    const id = 'inst-' + Date.now() + '-' + Math.floor(Math.random() * 1000);
    try {
      if (await ports.isTaken(port)) {
        return { ok: false, error: '端口 ' + port + ' 已被占用（本机已有进程在监听，或已被系统服务登记）' };
      }
    } catch {  }
    try { ports.registerUser(port, 'inst:' + id); } catch (e) { return { ok: false, error: '端口 ' + port + ' 与系统服务端口冲突（' + (e.message || e) + '）' }; }
    const inst = model.createRecord(payload, id);
    store.instances.push(inst);
    store.save();
    lifecycle._prepareSystemd();
    if (hooks.onCreate) { try { hooks.onCreate(inst); } catch (e) { logger.warn && logger.warn('onCreate(' + id + '): ' + (e && e.message)); } }
    if (events) events.append('inst_added', { id, name: inst.name, port });
    return { ok: true, instance: inst };
  }

  function removeInstance(id) {
    const inst = store.instances.find((i) => i.id === id);
    if (tasks && tasks.isBusy('instance', id)) {
      return { ok: false, error: '该实例有进行中的安装/升级作业，请等待其完成后再删除' };
    }
    const before = store.instances.length;
    const kept = store.instances.filter((i) => i.id !== id);
    if (kept.length === before) return { ok: false, error: '实例不存在' };
    store.replace(kept);
    store.save();
    if (tokens) tokens.detach(inst.id);
    if (inst) { try { ports.unregister('inst:' + id); } catch {} }
    const unit = 'dsh-web@' + id;
    const ctx = sandbox.launchCtx(instancesRoot, dshBin, inst);
    let stopOk;
    try { stopOk = service.stopUnit(unit, ctx) !== false; } catch { stopOk = true; }
    let stillActive = !stopOk;
    if (stopOk) {
      try {
        const active = service.isUnitActive(unit, ctx);
        stillActive = active !== false;
      } catch { stillActive = true; }
    }
    if (inst && inst.domain === 'sandbox' && inst.id !== 'main' && !stillActive) {
      const root = sandbox.root(instancesRoot, inst);
      setImmediate(() => {
        try { fs.rmSync(root, { recursive: true, force: true }); }
        catch (e) { logger.warn && logger.warn('清理沙箱目录失败 ' + root + ': ' + e.message); }
      });
    } else if (stillActive) {
      logger.warn && logger.warn('[' + id + '] 单元 ' + unit + ' 仍在运行，已保留实例数据目录（防不可逆丢失）');
      if (events) events.append('inst_remove_data_preserved', { id, reason: 'unit-still-active' });
    }
    if (hooks.onRemove) hooks.onRemove(id, store.instances);
    if (hooks.onDestroy) { try { hooks.onDestroy(id); } catch (e) { logger.warn && logger.warn('onDestroy(' + id + '): ' + (e && e.message)); } }
    if (events) events.append('inst_removed', { id });
    return stillActive ? { ok: true, dataPreserved: true, preserveReason: 'unit-still-active' } : { ok: true };
  }

  function updateInstance(id, patch) {
    const inst = store.instances.find((i) => i.id === id);
    if (!inst) return { ok: false, error: '实例不存在' };
    if (patch.remoteToken !== undefined) {
      const next0 = String(patch.remoteToken || '');
      if (next0 && !remoteTokenStrength(next0).ok) return { ok: false, error: '远程访问令牌（remoteToken）至少 8 位' };
    }
    if (patch.guardian !== undefined) {
      const gChanged = inst.guardian !== !!patch.guardian;
      inst.guardian = !!patch.guardian;
      if (gChanged && events) events.append('inst_guardian_changed', { id: inst.id, name: inst.name, enabled: inst.guardian === true });
    }
    let remoteChanged = false;
    if (patch.remoteMode !== undefined) {
      const next0m = patch.remoteMode === 'lan' || patch.remoteMode === 'wan' ? patch.remoteMode : 'off';
      const changed = inst.remoteMode !== next0m;
      inst.remoteMode = next0m;
      if (changed && events) events.append('inst_remote_changed', { id: inst.id, name: inst.name, mode: next0m });
      if (changed) remoteChanged = true;
    }
    if (patch.remoteToken !== undefined) {
      const next = String(patch.remoteToken || '');
      if (inst.remoteToken !== next) {
        inst.remoteToken = next;
        remoteChanged = true;
        if (events) events.append('inst_remote_token_changed', { id: inst.id, name: inst.name, tokenSet: next !== '' });
      }
    }
    if (remoteChanged && hooks.onRemoteChange) hooks.onRemoteChange(inst);
    store.save();
    return { ok: true, instance: inst };
  }

  function startTimer(intervalMs) {
    if (timer) clearInterval(timer);
    timer = setInterval(() => {
      for (const inst of store.instances) {
        if (inst.domain === 'native') continue;
        try { lifecycle.supervise(inst.id); } catch {}
      }
      try { lifecycle.governSweep(); } catch (e) { logger.warn && logger.warn('governSweep: ' + (e && e.message)); }
    }, intervalMs || 5000);
  }

  return { list, addInstance, removeInstance, updateInstance, startTimer };
}

module.exports = { createOps };
