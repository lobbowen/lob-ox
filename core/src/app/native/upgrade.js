'use strict';

const policies = require('./policies');
const BRAND = require('../../shared/brand');

function log(host, msg) { host._appendUpgradeLog(msg); }
function taskLog(host, task, msg) { if (task && host.tasks) host.tasks.log(task.id, msg); }

function markStep(host, task, title) {
  if (!task) return;
  const s = host.tasks.step(task.id, title);
  host.tasks.stepState(task.id, host.tasks.get(task.id).steps.indexOf(s), 'running');
}

function doneLastStep(host, task) {
  if (!task) return;
  const steps = host.tasks.get(task.id).steps;
  const st = steps[steps.length - 1];
  if (st) host.tasks.stepState(task.id, steps.indexOf(st), 'done');
}

function beginUpgradeState(host, requestedVersion) {
  host.upgradeState = 'installing';
  host.upgradeStartedAt = new Date().toISOString();
  host.upgradeFinishedAt = null;
  host.upgradeError = null;
  host.rolledBack = false;
  host.upgradeLog = [];
  host.targetVersion = requestedVersion || null;
}

function beginTask(host, requestedVersion) {
  if (!host.tasks) return null;
  const oldV = host.installedVersion();
  const task = host.tasks.begin('native', 'upgrade', { id: 'main', name: '原生 DeepSeek Harness' }, { from: oldV, to: requestedVersion || null, createdBy: 'user' });
  host.tasks.start(task.id);
  host._activeTaskId = task.id;
  return task;
}

async function resolveTarget(host, requestedVersion, task) {
  if (requestedVersion) return { version: requestedVersion, origin: null };
  taskLog(host, task, '查询最新版本…');
  log(host, '查询最新版本…');
  const info = await host._latestVersion();
  if (!info || !info.ok || !info.version) throw new Error((info && info.error) || '无法从任何 registry 获取最新版本');
  return { version: info.version, origin: info.origin };
}

async function stopForUpgrade(host, task) {
  if (!(host.hooks.isDshActive && host.hooks.isDshActive())) return;
  host.upgradeState = 'restarting';
  log(host, '停止 DSH 以便安全安装…');
  if (host.events) host.events.append(BRAND.EVENT_UPGRADE_STOPPING_HARNESS, {});
  if (task) {
    markStep(host, task, '停止 DSH');
    host.tasks.log(task.id, '停止 DSH 以便安全安装…');
  }
  if (host.hooks.stopForUpgrade) await host.hooks.stopForUpgrade();
}

async function installTarget(host, oldV, target, origin, task) {
  const registry = origin || await host._selectRegistry();
  markStep(host, task, '安装 ' + target);
  const res = await host._runNpm({ action: 'install', version: target, registry });
  if (!res.ok) throw new Error(res.error || 'install failed');
  const newV = host.installedVersion();
  if (newV !== target) throw new Error('安装后版本校验失败：期望 ' + target + '，实际 ' + newV);
  await host._recordManifest(newV || target);
  if (host.events) host.events.append('upgrade_installed', { from: oldV, to: target });
  log(host, '安装完成，磁盘版本 ' + newV);
  if (task) { host.tasks.log(task.id, '安装完成，磁盘版本 ' + newV); doneLastStep(host, task); }
  return newV;
}

function finishUpToDate(host, oldV, target, task) {
  host.upgradeState = 'done';
  host.upgradeFinishedAt = new Date().toISOString();
  log(host, '已安装 ' + oldV + '，目标 ' + target + ' 不更新。');
  if (host.events) host.events.append('upgrade_skipped', { from: oldV, to: target });
  if (task) { host.tasks.log(task.id, '已安装 ' + oldV + '，目标 ' + target + ' 不更新'); host.tasks.skip(task.id, '已是最新版本'); }
  host._activeTaskId = null;
  return { ok: true, result: 'up-to-date', from: oldV, to: target };
}

function finishStopped(host, oldV, target, task) {
  host.upgradeState = 'done';
  host.upgradeFinishedAt = new Date().toISOString();
  log(host, 'DSH 期望状态为 stopped；下次 start 将使用新版本。');
  if (host.events) host.events.append('upgrade_done', { from: oldV, to: target, note: 'desired=stopped' });
  if (task) { host.tasks.log(task.id, 'DSH 期望状态为 stopped；下次 start 将使用新版本'); host.tasks.succeed(task.id); }
  host._activeTaskId = null;
  if (host.hooks.resumeAfterUpgrade) host.hooks.resumeAfterUpgrade();
  return { ok: true, result: 'installed', from: oldV, to: target };
}

function finishVerified(host, oldV, target, task) {
  host.upgradeState = 'done';
  host.upgradeFinishedAt = new Date().toISOString();
  log(host, '健康验证通过，升级完成（' + oldV + ' → ' + target + '）。');
  if (host.events) host.events.append('upgrade_done', { from: oldV, to: target });
  if (task) { host.tasks.log(task.id, '健康验证通过，升级完成（' + oldV + ' → ' + target + '）'); host.tasks.succeed(task.id); }
  host._activeTaskId = null;
  if (host.hooks.notify) host.hooks.notify('DSH 升级完成', oldV + ' → ' + target);
  return { ok: true, result: 'upgraded', from: oldV, to: target };
}

async function verifyAndFinalize(host, oldV, target, task) {
  host.upgradeState = 'verifying';
  markStep(host, task, '拉起并验证');
  log(host, '重新拉起 DSH，等待健康验证…');
  taskLog(host, task, '重新拉起 DSH，等待健康验证…');
  if (host.hooks.resumeAfterUpgrade) host.hooks.resumeAfterUpgrade();
  const port = host._targetPort();
  if (!port) {
    const msg = '无法确定原生 DSH 端口（healthUrl 缺失）';
    host.upgradeState = 'failed';
    host.upgradeError = msg;
    if (task) host.tasks.fail(task.id, msg);
    host._activeTaskId = null;
    return { ok: false, error: msg, state: host.upgradeState };
  }
  const deadline = host.hooks.verifyDeadlineMs ? host.hooks.verifyDeadlineMs() : 120000;
  const healthy = await host._waitNativeHealthy(port, host._mainUnit(), deadline);
  if (healthy.ok) return finishVerified(host, oldV, target, task);
  return rollbackAfterFailedVerify(host, oldV, task, healthy);
}

async function rollbackAfterFailedVerify(host, oldV, task, healthy) {
  log(host, '健康验证失败（' + healthy.reason + '）');
  if (task) host.tasks.log(task.id, '健康验证失败（' + healthy.reason + '）');
  host.upgradeState = 'rolling_back';
  const rb = await rollbackNative(host, oldV, task);
  host.rolledBack = rb.ok === true;
  host.upgradeError = rb.ok ? ('升级失败，已回滚到 ' + oldV) : ('升级失败且回滚失败：' + (rb.error || ''));
  host.upgradeState = 'failed';
  host.upgradeFinishedAt = new Date().toISOString();
  if (host.events) host.events.append('upgrade_failed', { error: host.upgradeError, rolledBack: rb.ok });
  if (task) host.tasks.fail(task.id, host.upgradeError, { meta: { rolledBack: rb.ok, rolledBackTo: rb.ok ? oldV : null } });
  host._activeTaskId = null;
  return { ok: false, error: host.upgradeError, state: host.upgradeState };
}

async function rollbackNative(host, oldVersion, task) {
  const tlog = (msg) => { log(host, msg); taskLog(host, task, msg); };
  if (!oldVersion) { tlog('无旧版本可回滚'); return { ok: false, error: 'no old version to rollback' }; }
  tlog('自动回滚到 ' + oldVersion + '…');
  const registry = await host._selectRegistry();
  const res = await host._runNpm({ action: 'install', version: oldVersion, registry });
  let okVer = false;
  try { okVer = host.installedVersion() === oldVersion; } catch {}
  if (!res.ok || !okVer) {
    tlog('回滚也失败了！请人工检查 npm 全局目录。');
    return { ok: false, error: res.error || 'rollback install failed' };
  }
  tlog('回滚完成，磁盘版本 ' + oldVersion);
  try { await host._recordManifest(oldVersion); } catch (e2) { tlog('manifest 更新失败: ' + e2.message); }
  if (host.hooks.resumeAfterUpgrade) host.hooks.resumeAfterUpgrade();
  const port = host._targetPort();
  if (port) {
    const healthy = await host._waitNativeHealthy(port, host._mainUnit(), 60000);
    if (healthy.ok) tlog('回滚后实例已恢复运行');
    else tlog('回滚后实例未恢复（' + healthy.reason + '）');
  }
  return { ok: true };
}

async function rollbackAfterFailure(host) {
  host.upgradeState = 'rolling_back';
  if (host.events) host.events.append('upgrade_rollback_started', { to: host.oldVersion });
  log(host, '回滚到 ' + host.oldVersion + '…');
  const registry = await host._selectRegistry();
  const res = await host._runNpm({ action: 'install', version: host.oldVersion, registry });
  let okVer = false;
  try { okVer = host.installedVersion() === host.oldVersion; } catch {}
  if (!res.ok || !okVer) {
    const taskId = host._activeTaskId || null;
    host.upgradeState = 'failed';
    host.upgradeFinishedAt = new Date().toISOString();
    log(host, '回滚也失败了！请人工检查 npm 全局目录。');
    if (host.events) host.events.append('upgrade_rollback_failed', {});
    if (host.hooks.notify) host.hooks.notify('DSH 升级失败', '回滚也失败，请立即人工检查 npm 全局目录');
    if (taskId && host.tasks) host.tasks.fail(taskId, '回滚也失败：' + host.upgradeError, { meta: { rolledBack: false, rollbackFailed: true } });
    return { ok: false };
  }
  log(host, '回滚完成。');
  host.rolledBack = true;
  try { await host._recordManifest(host.oldVersion); } catch (e2) { log(host, 'manifest 更新失败: ' + e2.message); }
  host.upgradeState = 'failed';
  host.upgradeFinishedAt = new Date().toISOString();
  if (host.events) host.events.append('upgrade_failed', { error: host.upgradeError || '升级失败', rolledBack: true, rolledBackTo: host.oldVersion });
  const taskId = host._activeTaskId || null;
  if (taskId && host.tasks) {
    host.tasks.log(taskId, '回滚到 ' + host.oldVersion + ' 完成');
    host.tasks.fail(taskId, host.upgradeError, { meta: { rolledBack: true, rolledBackTo: host.oldVersion } });
  }
  return { ok: true };
}

async function handleUpgradeFailure(host, err) {
  host.upgradeError = err.message;
  if (host.events) host.events.append('upgrade_failed', { error: err.message, target: host.targetVersion });
  log(host, '失败：' + err.message);
  const taskId = host._activeTaskId || null;
  if (taskId && host.tasks) host.tasks.log(taskId, '失败：' + err.message);
  let cur = null;
  try { cur = host.installedVersion(); } catch {}
  if (policies.needsRollback(host.config, host.oldVersion, cur)) {
    await rollbackAfterFailure(host);
  } else {
    host.upgradeState = 'failed';
    host.upgradeFinishedAt = new Date().toISOString();
    if (cur === host.oldVersion) log(host, '磁盘仍是旧版本，无需回滚。');
    if (host.hooks.notify) host.hooks.notify('DSH 升级失败', err.message);
    if (taskId && host.tasks) host.tasks.fail(taskId, err.message, { meta: { rolledBack: false } });
  }
  if (host.hooks.desiredRunning && host.hooks.desiredRunning()) log(host, '恢复启动 DSH（当前磁盘版本）。');
  if (host.hooks.resumeAfterUpgrade) host.hooks.resumeAfterUpgrade();
  host._activeTaskId = null;
}

async function upgrade(host, requestedVersion) {
  if (!policies.isValidVersion(requestedVersion)) return { ok: false, error: '非法版本号: ' + requestedVersion };
  beginUpgradeState(host, requestedVersion);
  const task = beginTask(host, requestedVersion);
  try {
    const oldV = host.installedVersion();
    host.oldVersion = oldV;
    const pick = await resolveTarget(host, requestedVersion, task);
    const target = pick.version;
    host.targetVersion = target;
    taskLog(host, task, '目标版本 ' + target);
    if (!oldV) {
      if (host.events) host.events.append('upgrade_fresh_install', { to: target });
      log(host, '未检测到已安装的 DeepSeek Harness，执行全新安装：' + target);
      taskLog(host, task, '未检测到已安装的 DeepSeek Harness，执行全新安装：' + target);
    } else if (policies.isUpToDate(target, oldV)) {
      return finishUpToDate(host, oldV, target, task);
    }
    if (host.events) host.events.append('upgrade_started', { from: oldV, to: target });
    log(host, '升级 ' + oldV + ' → ' + target);
    taskLog(host, task, '升级 ' + oldV + ' → ' + target);
    await stopForUpgrade(host, task);
    await installTarget(host, oldV, target, pick.origin, task);
    if (!(host.hooks.desiredRunning && host.hooks.desiredRunning())) return finishStopped(host, oldV, target, task);
    return await verifyAndFinalize(host, oldV, target, task);
  } catch (err) {
    await handleUpgradeFailure(host, err);
    return { ok: false, error: err.message, state: host.upgradeState };
  }
}

module.exports = { upgrade };
