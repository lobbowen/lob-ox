'use strict';

const fs = require('node:fs');
const ports = require('../../platform/service/ports').shared;
const { remoteTokenStrength } = require('../../shared/credential');
const OUTCOME = require('../../shared/outcome');
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

  // 审计 P0-I5：service.stopUnit 现已为 async，删除实例时必须 await 停止确认后再判 isUnitActive，
  // 否则会带着"仍在运行"的陈旧判据删数据或报错（与 stop() 同源修正）。
  async function removeInstance(id) {
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
    // 端口回收失败要留痕：静默会让账本残留 inst:<id> 记录，之后该端口被判定为"已占用"。
    if (inst) {
      try { ports.unregister('inst:' + id); }
      catch (e) { logger.warn && logger.warn('[' + id + '] 端口回收失败（账本可能残留）: ' + (e && e.message)); }
    }
    const unit = 'dsh-web@' + id;
    const ctx = sandbox.launchCtx(instancesRoot, dshBin, inst);
    let stopOk;
    try { stopOk = (await service.stopUnit(unit, ctx)) !== false; }
    catch (e) {
      // 抛出"不支持/无服务管理器"（CapabilityError）＝ 该平台根本没有单元概念 ⇒ 无进程在跑，
      //     不是"判不出"，删除应继续。其它异常才是真正的停止失败 ⇒ 保守保留数据。
      const unsupported = !!(e && (e.name === 'CapabilityError' || e.code === 'CAPABILITY_UNSUPPORTED'));
      stopOk = unsupported;
      logger.warn && logger.warn('[' + id + '] stopUnit '
        + (unsupported ? '能力不支持（无单元可停，按未运行继续）' : '异常（不得视为已停止）') + ': ' + (e && e.message));
    }
    // isUnitActive 返回 Outcome 三态：unknown 必须显式处置，不得再当"活跃"（此前的 P0）。
    let active = OUTCOME.UNKNOWN;
    if (stopOk) {
      try { active = service.isUnitActive(unit, ctx); }
      catch (e) { active = OUTCOME.UNKNOWN; logger.warn && logger.warn('[' + id + '] isUnitActive 异常: ' + (e && e.message)); }
      // 兼容旧桩：返回布尔（false/true）时按 fail/ok 归一，避免被当成 unknown 而卡住删除。
      if (typeof active === 'boolean') active = active ? OUTCOME.OK : OUTCOME.fail('stub: 未在跑');
    } else {
      // 停止确实失败且平台支持 ⇒ 保守：按"仍在运行"处理，保留数据目录。
      active = OUTCOME.OK;
    }
    const stillActive = OUTCOME.isOk(active);
    const activeUnknown = OUTCOME.isUnknown(active);
    if (inst && inst.domain === 'sandbox' && inst.id !== 'main' && !stillActive && !activeUnknown) {
      const root = sandbox.root(instancesRoot, inst);
      setImmediate(() => {
        try { fs.rmSync(root, { recursive: true, force: true }); }
        catch (e) { logger.warn && logger.warn('清理沙箱目录失败 ' + root + ': ' + e.message); }
      });
    } else if (activeUnknown) {
      // 状态未知：保留数据目录并如实告警，不得报"删除成功"（数据保留优先于流程完成）。
      logger.warn && logger.warn('[' + id + '] 单元 ' + unit + ' 状态未知，已保留实例数据目录（防不可逆丢失）');
      if (events) events.append('inst_remove_data_preserved', { id, reason: 'unit-state-unknown' });
    } else if (stillActive) {
      logger.warn && logger.warn('[' + id + '] 单元 ' + unit + ' 仍在运行，已保留实例数据目录（防不可逆丢失）');
      if (events) events.append('inst_remove_data_preserved', { id, reason: 'unit-still-active' });
    }
    if (hooks.onRemove) hooks.onRemove(id, store.instances);
    if (hooks.onDestroy) { try { hooks.onDestroy(id); } catch (e) { logger.warn && logger.warn('onDestroy(' + id + '): ' + (e && e.message)); } }
    if (events) events.append('inst_removed', { id });
    // 未知 ⇒ 不得报 ok:true（此前正是把 unknown 当成功，导致"以为删了、数据还在"）。
    if (activeUnknown) return { ok: false, error: '单元状态未知，未确认停止；已保留实例数据目录', dataPreserved: true, preserveReason: 'unit-state-unknown' };
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
        // 单实例 supervise 失败不得静默：否则该实例会长期停在陈旧相位而无人察觉。
        try { lifecycle.supervise(inst.id); }
        catch (e) { logger.warn && logger.warn('[' + inst.id + '] supervise 失败: ' + (e && e.message)); }
      }
      try { lifecycle.governSweep(); } catch (e) { logger.warn && logger.warn('governSweep: ' + (e && e.message)); }
    }, intervalMs || 5000);
  }

  return { list, addInstance, removeInstance, updateInstance, startTimer };
}

module.exports = { createOps };
