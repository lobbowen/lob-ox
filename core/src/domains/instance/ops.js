'use strict';

// 持久化/沙箱目录/端口登记经 store/sandbox/ports；启停与监督经 deps.lifecycle，版本/作业视图经 deps.upgrade（组装根注入）。无隐式 this。
const fs = require('node:fs');
const ports = require('../../platform/service/ports').shared;
// 远程令牌强度下限与 relay/core 共用一份实现（shared/credential）；直接 require 兄弟域 relay/core 会构成跨域边（DS-G1 判红）。
const { remoteTokenStrength } = require('../../shared/credential');
const model = require('./model');
const sandbox = require('./sandbox');

function createOps(deps) {
  const { store, lifecycle, upgrade, service, logger, events, tokens, tasks, hooks, instancesRoot, dshBin } = deps;
  let timer = null;

  /** 单实例映射到前端契约行（IO 结果由 upgrade/lifecycle 解析后传入纯 model.viewRow）。 */
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

  /** 新增实例：生成独立 unit 名与独立配置（默认标准隔离，见 model.createRecord）。 */
  async function addInstance(payload) {
    const port = parseInt(payload.port, 10);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) return { ok: false, error: '无效端口' };
    if (store.instances.some((i) => i.port === port)) return { ok: false, error: '端口 ' + port + ' 已被实例占用' };
    // 写入口强度闸：remoteToken 守护的是经 frp 暴露的 DSH 特权面，1~7 位令牌等同无令牌；
    // 后续闸口虽会拒执行，但这里必须拒绝落盘而非静默存弱值。
    const tk = String(payload.remoteToken || '');
    if (tk && !remoteTokenStrength(tk).ok) return { ok: false, error: '远程访问令牌（remoteToken）至少 8 位' };
    const id = 'inst-' + Date.now() + '-' + Math.floor(Math.random() * 1000);
    // 必须探测本机实际监听（仅查实例重名与注册表会建到被占端口，bind 失败后陷入 BACKOFF 反复重试）。
    try {
      if (await ports.isTaken(port)) {
        return { ok: false, error: '端口 ' + port + ' 已被占用（本机已有进程在监听，或已被系统服务登记）' };
      }
    } catch { /* 探测失败不阻断创建：交给启动期如实报错 */ }
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
    // 删除与进行中的安装/升级作业互斥（检查必须先于任何状态变更）：否则 npm install 会重建
    // 已删实例的 install/，守卫内存已无该实例，孤儿永久占盘。
    if (tasks && tasks.isBusy('instance', id)) {
      return { ok: false, error: '该实例有进行中的安装/升级作业，请等待其完成后再删除' };
    }
    const before = store.instances.length;
    const kept = store.instances.filter((i) => i.id !== id);
    if (kept.length === before) return { ok: false, error: '实例不存在' };
    store.replace(kept); // 原地替换：外部持有的 instances 数组引用身份保持不变
    store.save();
    if (tokens) tokens.detach(inst.id); // 唯一令牌节点：删除实例即注销其源与令牌
    // 端口释放按 owner 精确进行：不带 ownerId 的 release 会删掉他人登记。
    if (inst) { try { ports.unregister('inst:' + id); } catch {} }
    // 删数据目录前必须确认单元真的停了：停止失败（含 is-active 因 dbus 挂起超时）一律按未停止处理、
    // 保守保留数据；不支持用户单元的平台 stopUnit 抛 CapabilityError = 无单元可停，不算失败。
    const unit = 'dsh-web@' + id;
    // portable 档归属锚（端口/run.pid/cmdline），systemd 档忽略；与 stop 用同一份 ctx，两侧语义才对称。
    const ctx = sandbox.launchCtx(instancesRoot, dshBin, inst);
    let stopOk;
    try { stopOk = service.stopUnit(unit, ctx) !== false; } catch { stopOk = true; }
    let stillActive = !stopOk;
    if (stopOk) {
      try {
        // 停止已确认后二次复核：仅显式 false 视为已停；true / null / undefined（查询失败）一律按活跃处理。
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
    // 删除确认框承诺「彻底删除」，实际数据可能被保留：安全结果必须以 dataPreserved 对用户可见。
    return stillActive ? { ok: true, dataPreserved: true, preserveReason: 'unit-still-active' } : { ok: true };
  }

  function updateInstance(id, patch) {
    const inst = store.instances.find((i) => i.id === id);
    if (!inst) return { ok: false, error: '实例不存在' };
    // 令牌强度校验前置到任何字段变更之前：先改其余字段再被拒会留下 guardian/remoteMode 半改状态。
    // 空串=清除（放行），非空但过短=拒绝整次补丁。
    if (patch.remoteToken !== undefined) {
      const next0 = String(patch.remoteToken || '');
      if (next0 && !remoteTokenStrength(next0).ok) return { ok: false, error: '远程访问令牌（remoteToken）至少 8 位' };
    }
    if (patch.guardian !== undefined) {
      const gChanged = inst.guardian !== !!patch.guardian;
      inst.guardian = !!patch.guardian;
      if (gChanged && events) events.append('inst_guardian_changed', { id: inst.id, name: inst.name, enabled: inst.guardian === true });
    }
    // remoteMode/remoteToken 任一变化都必须触发 onRemoteChange：只换令牌不同步会让运行中的
    // relay 继续放行旧令牌、frpc 不收敛。
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
        // 事件只记「是否已设」，绝不带令牌值（TK-5 脱敏纪律）
        if (events) events.append('inst_remote_token_changed', { id: inst.id, name: inst.name, tokenSet: next !== '' });
      }
    }
    if (remoteChanged && hooks.onRemoteChange) hooks.onRemoteChange(inst);
    store.save();
    return { ok: true, instance: inst };
  }

  /** 兜底定时驱动（主路径不用——实例监督并入守卫唯一心跳；仅 ManagedRegistry 不可用时降级）。 */
  function startTimer(intervalMs) {
    if (timer) clearInterval(timer);
    timer = setInterval(() => {
      for (const inst of store.instances) {
        if (inst.domain === 'native') continue;
        try { lifecycle.supervise(inst.id); } catch {}
      }
      // B2-6e：decide/下发/处置每拍恰一次，挂拍末而非逐实例监督拍（与 heartbeat onBeatDone 同构）。
      try { lifecycle.governSweep(); } catch (e) { logger.warn && logger.warn('governSweep: ' + (e && e.message)); }
    }, intervalMs || 5000);
  }

  return { list, addInstance, removeInstance, updateInstance, startTimer };
}

module.exports = { createOps };
