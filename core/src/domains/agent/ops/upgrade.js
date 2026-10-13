'use strict';

// agent 升级（五件套之三，最复杂的一份）。
//
// 从两份并行实现收拢：
//   原生实现              254 行（含完整回滚）
//   domains/instance/upgrade.js      211 行（沙箱化）
//
// 收拢策略：保留全部流程不变量，只把 host 依赖改为显式注入。
// 原实现读 host.upgradeState / host.hooks.xxx / host._runNpm 等十几个过程式字段，
// 那是两份实现各自演化的结果，也是它们无法共用的根因。
//
// 本模块的形参是一个显式 env 对象，所有字段都可选（缺什么就跳过那一步）：
//   log(msg) / events / tasks
//   installedVersion() / latestVersion() / install(v, registry) / selectRegistry()
//   recordManifest(v) / isActive() / stopForUpgrade() / resume()
//   desiredRunning() / waitHealthy(port, deadlineMs) / targetPort()
//   mainUnit() / notify(title, body) / verifyDeadlineMs()
//
// 这让同一份升级流程能服务两种形态——沙箱与原生的 hooks 集合本就不同。

const status = require('../status');

// 升级阶段机。与原实现的 upgradeState 取值一致，UI 与任务面板免改。
const PHASES = ['idle', 'installing', 'restarting', 'verifying', 'rolling_back', 'done', 'failed'];

function nowIso() { return new Date().toISOString(); }

async function upgrade(env, requestedVersion, cfg) {
  const e = env || {};
  const c = cfg || {};
  const log = (m) => { if (e.log) { try { e.log(m); } catch {  } } };
  const ev = (type, data) => { if (e.events) { try { e.events.append(type, data || {}); } catch {  } } };

  const st = {
    phase: 'installing',
    startedAt: nowIso(),
    finishedAt: null,
    error: null,
    rolledBack: false,
    targetVersion: requestedVersion || null,
    oldVersion: null,
  };

  const task = beginTask(e, requestedVersion);

  const tlog = (m) => { if (task && e.tasks) { try { e.tasks.log(task.id, m); } catch {  } } };
  const tstep = (title) => {
    if (!task || !e.tasks) return;
    try {
      const s = e.tasks.step(task.id, title);
      const cur = e.tasks.get(task.id);
      e.tasks.stepState(task.id, cur.steps.indexOf(s), 'running');
    } catch {  }
  };
  const tdoneLast = () => {
    if (!task || !e.tasks) return;
    try {
      const cur = e.tasks.get(task.id);
      const steps = cur.steps;
      const s = steps[steps.length - 1];
      if (s) e.tasks.stepState(task.id, steps.indexOf(s), 'done');
    } catch {  }
  };

  try {
    if (!status.isValidVersion(requestedVersion)) {
      return { ok: false, error: '非法版本号: ' + requestedVersion, state: st.phase };
    }

    const oldV = e.installedVersion ? e.installedVersion() : null;
    st.oldVersion = oldV;

    let target = requestedVersion;
    let origin = null;
    if (!target) {
      tlog('查询最新版本…');
      log('查询最新版本…');
      const info = e.latestVersion ? await e.latestVersion() : null;
      if (!info || info.ok !== true || !info.version) {
        throw new Error((info && info.error) || '无法从任何 registry 获取最新版本');
      }
      target = info.version;
      origin = info.origin || null;
    }
    st.targetVersion = target;
    tlog('目标版本 ' + target);

    if (!oldV) {
      ev('upgrade_fresh_install', { to: target });
      log('未检测到已安装的 agent，执行全新安装：' + target);
      tlog('未检测到已安装的 agent，执行全新安装：' + target);
    } else if (status.isUpToDate(target, oldV)) {
      st.phase = 'done';
      st.finishedAt = nowIso();
      log('已安装 ' + oldV + '，目标 ' + target + ' 不更新。');
      ev('upgrade_skipped', { from: oldV, to: target });
      if (task && e.tasks) {
        try { e.tasks.log(task.id, '已安装 ' + oldV + '，目标 ' + target + ' 不更新'); e.tasks.skip(task.id, '已是最新版本'); } catch {  }
      }
      return { ok: true, result: 'up-to-date', from: oldV, to: target, state: st.phase };
    }

    ev('upgrade_started', { from: oldV, to: target });
    log('升级 ' + oldV + ' → ' + target);
    tlog('升级 ' + oldV + ' → ' + target);

    if (e.isActive && e.isActive()) {
      st.phase = 'restarting';
      log('停止 agent 以便安全安装…');
      ev('upgrade_stopping_harness', {});
      tstep('停止 agent');
      tlog('停止 agent 以便安全安装…');
      if (e.stopForUpgrade) await e.stopForUpgrade();
    }

    st.phase = 'installing';
    const registry = origin || (e.selectRegistry ? await e.selectRegistry() : null);
    tstep('安装 ' + target);
    const res = e.install ? await e.install(target, registry) : { ok: false, error: 'env.install 未提供' };
    if (!res || res.ok !== true) throw new Error((res && res.error) || 'install failed');
    const newV = e.installedVersion ? e.installedVersion() : target;
    if (newV !== target) throw new Error('安装后版本校验失败：期望 ' + target + '，实际 ' + newV);
    if (e.recordManifest) { try { await e.recordManifest(newV || target); } catch {  } }
    ev('upgrade_installed', { from: oldV, to: target });
    log('安装完成，磁盘版本 ' + newV);
    tlog('安装完成，磁盘版本 ' + newV);
    tdoneLast();

    if (!(e.desiredRunning && e.desiredRunning())) {
      st.phase = 'done';
      st.finishedAt = nowIso();
      log('agent 期望状态为 stopped；下次 start 将使用新版本。');
      ev('upgrade_done', { from: oldV, to: target, note: 'desired=stopped' });
      if (task && e.tasks) {
        try { e.tasks.log(task.id, '期望 stopped；下次 start 用新版本'); e.tasks.succeed(task.id); } catch {  }
      }
      if (e.resume) { try { await e.resume(); } catch {  } }
      return { ok: true, result: 'installed', from: oldV, to: target, state: st.phase };
    }

    st.phase = 'verifying';
    tstep('拉起并验证');
    log('重新拉起 agent，等待健康验证…');
    tlog('重新拉起 agent，等待健康验证…');
    if (e.resume) { try { await e.resume(); } catch {  } }

    const port = e.targetPort ? e.targetPort() : null;
    if (!port) {
      const msg = '无法确定 agent 端口（healthUrl 缺失）';
      st.phase = 'failed';
      st.error = msg;
      if (task && e.tasks) { try { e.tasks.fail(task.id, msg); } catch {  } }
      return { ok: false, error: msg, state: st.phase };
    }
    const deadline = e.verifyDeadlineMs ? e.verifyDeadlineMs() : 120000;
    const healthy = e.waitHealthy ? await e.waitHealthy(port, deadline) : { ok: false, reason: 'env.waitHealthy 未提供' };

    if (healthy && healthy.ok) {
      st.phase = 'done';
      st.finishedAt = nowIso();
      log('健康验证通过，升级完成（' + oldV + ' → ' + target + '）。');
      ev('upgrade_done', { from: oldV, to: target });
      tlog('健康验证通过，升级完成（' + oldV + ' → ' + target + '）');
      if (task && e.tasks) { try { e.tasks.succeed(task.id); } catch {  } }
      if (e.notify) { try { e.notify('agent 升级完成', oldV + ' → ' + target); } catch {  } }
      return { ok: true, result: 'upgraded', from: oldV, to: target, state: st.phase };
    }

    log('健康验证失败（' + (healthy && healthy.reason) + '）');
    tlog('健康验证失败（' + (healthy && healthy.reason) + '）');
    // 关掉自动回滚时，健康验证失败也不回滚——只如实报失败。
    // 原实现此处无条件回滚（rollbackAfterFailedVerify 不读配置），
    // 与异常路径的 needsRollback 判据不一致：同一个「升级失败」，
    // 两条路径的回滚行为不同。收拢时统一为都尊重 upgradeAutoRollback。
    if (c.upgradeAutoRollback === false || !oldV) {
      st.phase = 'failed';
      st.finishedAt = nowIso();
      st.error = '升级失败（健康验证未通过：' + (healthy && healthy.reason) + '），未回滚';
      ev('upgrade_failed', { error: st.error, rolledBack: false });
      if (task && e.tasks) {
        try { e.tasks.fail(task.id, st.error, { meta: { rolledBack: false } }); } catch {  }
      }
      return { ok: false, error: st.error, state: st.phase };
    }
    st.phase = 'rolling_back';
    const rb = await rollback(e, st, oldV, tlog, ev);
    st.rolledBack = rb.ok === true;
    st.error = rb.ok ? ('升级失败，已回滚到 ' + oldV) : ('升级失败且回滚失败：' + (rb.error || ''));
    st.phase = 'failed';
    st.finishedAt = nowIso();
    ev('upgrade_failed', { error: st.error, rolledBack: rb.ok });
    if (task && e.tasks) {
      try { e.tasks.fail(task.id, st.error, { meta: { rolledBack: rb.ok, rolledBackTo: rb.ok ? oldV : null } }); } catch {  }
    }
    return { ok: false, error: st.error, state: st.phase };
  } catch (err) {
    st.error = (err && err.message) || String(err);
    ev('upgrade_failed', { error: st.error, target: st.targetVersion });
    log('失败：' + st.error);
    const taskId = task ? task.id : null;
    if (taskId && e.tasks) { try { e.tasks.log(taskId, '失败：' + st.error); } catch {  } }

    let cur = null;
    try { cur = e.installedVersion ? e.installedVersion() : null; } catch {  }

    if (status.needsRollback(c, st.oldVersion, cur)) {
      await rollbackAfterFailure(e, st, task, tlog, ev);
    } else {
      st.phase = 'failed';
      st.finishedAt = nowIso();
      if (cur === st.oldVersion) log('磁盘仍是旧版本，无需回滚。');
      if (e.notify) { try { e.notify('agent 升级失败', st.error); } catch {  } }
      if (taskId && e.tasks) {
        try { e.tasks.fail(taskId, st.error, { meta: { rolledBack: false } }); } catch {  }
      }
    }

    if (e.desiredRunning && e.desiredRunning()) log('恢复启动 agent（当前磁盘版本）。');
    if (e.resume) { try { await e.resume(); } catch {  } }
    return { ok: false, error: st.error, state: st.phase };
  }
}

function beginTask(e, requestedVersion) {
  if (!e.tasks) return null;
  try {
    const oldV = e.installedVersion ? e.installedVersion() : null;
    const t = e.tasks.begin('agent', 'upgrade', { id: 'main', name: 'agent' }, {
      from: oldV,
      to: requestedVersion || null,
      createdBy: 'user',
    });
    e.tasks.start(t.id);
    return t;
  } catch { return null; }
}

// 健康验证失败后的回滚（原 rollbackNative）。
async function rollback(e, st, oldVersion, tlog, ev) {
  const log = (m) => { if (e.log) { try { e.log(m); } catch {  } } };
  if (!oldVersion) { tlog('无旧版本可回滚'); return { ok: false, error: 'no old version to rollback' }; }
  tlog('自动回滚到 ' + oldVersion + '…');
  const registry = e.selectRegistry ? await e.selectRegistry() : null;
  // 回滚安装也要防逃逸：回滚本身失败时，必须走到「回滚也失败了」的如实分支，
  // 而不是把异常抛回升级路径（那会把失败原因从「升级失败」歪曲成「回滚异常」）。
  let res;
  try {
    res = e.install ? await e.install(oldVersion, registry) : { ok: false, error: 'env.install 未提供' };
  } catch (e3) {
    tlog('回滚安装异常：' + ((e3 && e3.message) || e3));
    return { ok: false, error: (e3 && e3.message) || 'rollback install threw' };
  }
  let okVer = false;
  try { okVer = (e.installedVersion ? e.installedVersion() : null) === oldVersion; } catch {  }
  if (!res || res.ok !== true || !okVer) {
    tlog('回滚也失败了！请人工检查 npm 全局目录。');
    return { ok: false, error: (res && res.error) || 'rollback install failed' };
  }
  tlog('回滚完成，磁盘版本 ' + oldVersion);
  if (e.recordManifest) { try { await e.recordManifest(oldVersion); } catch (e2) { log('manifest 更新失败: ' + e2.message); } }
  if (e.resume) { try { await e.resume(); } catch {  } }
  const port = e.targetPort ? e.targetPort() : null;
  if (port && e.waitHealthy) {
    const h = await e.waitHealthy(port, 60000);
    if (h && h.ok) tlog('回滚后实例已恢复运行');
    else tlog('回滚后实例未恢复（' + (h && h.reason) + '）');
  }
  return { ok: true };
}

// 异常路径的回滚（原 rollbackAfterFailure）。
async function rollbackAfterFailure(e, st, task, tlog, ev) {
  const log = (m) => { if (e.log) { try { e.log(m); } catch {  } } };
  st.phase = 'rolling_back';
  ev('upgrade_rollback_started', { to: st.oldVersion });
  log('回滚到 ' + st.oldVersion + '…');
  const registry = e.selectRegistry ? await e.selectRegistry() : null;
  let res;
  try {
    res = e.install ? await e.install(st.oldVersion, registry) : { ok: false, error: 'env.install 未提供' };
  } catch (e3) {
    log('回滚安装异常：' + ((e3 && e3.message) || e3));
    st.phase = 'failed';
    st.finishedAt = nowIso();
    ev('upgrade_rollback_failed', {});
    const taskId = task ? task.id : null;
    if (taskId && e.tasks) {
      try { e.tasks.fail(taskId, '回滚也失败：' + ((e3 && e3.message) || e3), { meta: { rolledBack: false, rollbackFailed: true } }); } catch {  }
    }
    return { ok: false };
  }
  let okVer = false;
  try { okVer = (e.installedVersion ? e.installedVersion() : null) === st.oldVersion; } catch {  }
  if (!res || res.ok !== true || !okVer) {
    st.phase = 'failed';
    st.finishedAt = nowIso();
    log('回滚也失败了！请人工检查 npm 全局目录。');
    ev('upgrade_rollback_failed', {});
    if (e.notify) { try { e.notify('agent 升级失败', '回滚也失败，请立即人工检查 npm 全局目录'); } catch {  } }
    const taskId = task ? task.id : null;
    if (taskId && e.tasks) {
      try { e.tasks.fail(taskId, '回滚也失败：' + st.error, { meta: { rolledBack: false, rollbackFailed: true } }); } catch {  }
    }
    return { ok: false };
  }
  log('回滚完成。');
  st.rolledBack = true;
  if (e.recordManifest) { try { await e.recordManifest(st.oldVersion); } catch (e2) { log('manifest 更新失败: ' + e2.message); } }
  st.phase = 'failed';
  st.finishedAt = nowIso();
  ev('upgrade_failed', { error: st.error || '升级失败', rolledBack: true, rolledBackTo: st.oldVersion });
  const taskId = task ? task.id : null;
  if (taskId && e.tasks) {
    try {
      e.tasks.log(taskId, '回滚到 ' + st.oldVersion + ' 完成');
      e.tasks.fail(taskId, st.error, { meta: { rolledBack: true, rolledBackTo: st.oldVersion } });
    } catch {  }
  }
  return { ok: true };
}

module.exports = { upgrade, PHASES };