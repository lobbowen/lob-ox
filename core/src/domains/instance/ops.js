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

  
  
  async function removeInstance(id) {
    const inst = store.instances.find((i) => i.id === id);
    if (tasks && tasks.isBusy('instance', id)) {
      return { ok: false, error: '该实例有进行中的安装/升级作业，请等待其完成后再删除' };
    }
    const before = store.instances.length;
    const kept = store.instances.filter((i) => i.id !== id);
    if (kept.length === before) return { ok: false, error: '实例不存在' };
    // 删除是事务：记录提交点后移到「确认单元已停止」之后。
    // 在此之前只做「计算 kept」——若单元仍在跑或状态未知却先把记录删掉，
    // 实例就变成用户再也够不着的孤儿单元（removeInstance 会回答「实例不存在」）。
    const unit = 'dsh-web@' + id;
    const ctx = sandbox.launchCtx(instancesRoot, dshBin, inst);
    let stopOk;
    try { stopOk = (await service.stopUnit(unit, ctx)) !== false; }
    catch (e) {
      const unsupported = !!(e && (e.name === 'CapabilityError' || e.code === 'CAPABILITY_UNSUPPORTED'));
      stopOk = unsupported;
      logger.warn && logger.warn('[' + id + '] stopUnit '
        + (unsupported ? '能力不支持（无单元可停，按未运行继续）' : '异常（不得视为已停止）') + ': ' + (e && e.message));
    }
    
    let active = OUTCOME.UNKNOWN;
    if (stopOk) {
      try { active = await service.isUnitActive(unit, ctx); }
      catch (e) { active = OUTCOME.UNKNOWN; logger.warn && logger.warn('[' + id + '] isUnitActive 异常: ' + (e && e.message)); }
      
      if (typeof active === 'boolean') active = active ? OUTCOME.OK : OUTCOME.fail('stub: 未在跑');
      // 契约守卫：isUnitActive 必须同步返回 Outcome。若某个平台适配器改成异步，
      // await 之外的实现会拿到 Promise 并静默落入 isUnknown 分支，使 removeInstance
      // 永远无法确认已停止 —— 这里显式拒绝 rather than 悄悄退化。
      if (active && typeof active.then === 'function') {
        active = OUTCOME.UNKNOWN;
        logger.warn && logger.warn('[' + id + '] isUnitActive 返回了 Promise，契约要求同步 Outcome；按 UNKNOWN 处理（不删除记录）');
      }
    } else {
      // stopUnit 明确报告未停下：按「仍在运行」处理，保留记录与数据（原有语义）。
      active = OUTCOME.OK;
    }
    const stillActive = OUTCOME.isOk(active);
    const activeUnknown = OUTCOME.isUnknown(active);

    // 提交点：只有确认单元不再运行，删除记录才是可逆性已被排除的一步。
    store.replace(kept);
    store.save();
    if (tokens) tokens.detach(inst.id);
    try { ports.unregister('inst:' + id); }
    catch (e) { logger.warn && logger.warn('[' + id + '] 端口回收失败（账本可能残留）: ' + (e && e.message)); }

    if (inst && inst.kind === 'sandbox' && inst.id !== 'main' && !stillActive && !activeUnknown) {
      const root = sandbox.root(instancesRoot, inst);
      setImmediate(() => {
        try { fs.rmSync(root, { recursive: true, force: true }); }
        catch (e) { logger.warn && logger.warn('清理沙箱目录失败 ' + root + ': ' + e.message); }
      });
    } else if (activeUnknown) {
      // 状态未知：单元可能还在跑。恢复记录（用户仍能通过 UI 停掉它），只报告不删除。
      store.replace(store.instances.concat([inst]));
      store.save();
      logger.warn && logger.warn('[' + id + '] 单元 ' + unit + ' 状态未知，未删除实例记录并保留数据目录（防不可逆丢失与孤儿单元）');
      if (events) events.append('inst_remove_data_preserved', { id, reason: 'unit-state-unknown' });
    } else if (stillActive) {
      store.replace(store.instances.concat([inst]));
      store.save();
      logger.warn && logger.warn('[' + id + '] 单元 ' + unit + ' 仍在运行，未删除实例记录并保留数据目录（防不可逆丢失与孤儿单元）');
      if (events) events.append('inst_remove_data_preserved', { id, reason: 'unit-still-active' });
    }
    if (hooks.onRemove) hooks.onRemove(id, store.instances);
    if (hooks.onDestroy) { try { hooks.onDestroy(id); } catch (e) { logger.warn && logger.warn('onDestroy(' + id + '): ' + (e && e.message)); } }
    
    if (activeUnknown) return { ok: false, error: '单元状态未知，未确认停止；已保留实例记录与数据目录', dataPreserved: true, preserveReason: 'unit-state-unknown' };
    if (stillActive) {
      return { ok: false, error: '单元仍在运行，未删除实例记录；已保留实例数据目录', dataPreserved: true, preserveReason: 'unit-still-active' };
    }
    if (events) events.append('inst_removed', { id });
    return { ok: true };
  }

  function updateInstance(id, patch) {
    const inst = store.instances.find((i) => i.id === id);
    if (!inst) return { ok: false, error: '实例不存在' };
    if (patch.remoteToken !== undefined) {
      const next0 = String(patch.remoteToken || '');
      if (next0 && !remoteTokenStrength(next0).ok) return { ok: false, error: '远程访问令牌（remoteToken）至少 8 位' };
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

  return { list, addInstance, removeInstance, updateInstance };
}

module.exports = { createOps };
