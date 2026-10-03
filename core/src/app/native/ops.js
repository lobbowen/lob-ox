'use strict';

const fs = require('node:fs');
const policies = require('./policies');

const PKG_DEFAULT = '@deepseek-ai/dsh';

function status(host) {
  const bin = host.binPath();
  const installed = host.installedVersion();
  const activeTask = host.tasks ? host.tasks.current('native', 'main') : null;
  let state;
  if (host.installing || (activeTask && activeTask.action === 'install' && activeTask.state === 'running')) state = 'installing';
  else if (host.uninstalling || (activeTask && activeTask.action === 'uninstall' && activeTask.state === 'running')) state = 'uninstalling';
  else state = installed ? 'installed' : 'uninstalled';
  return {
    installed: installed !== null && installed !== '',
    version: installed || null,
    binPath: bin,
    executable: bin ? fs.existsSync(bin) : false,
    state,
    installLog: host.installLog.slice(-8),
    lastInstall: host.lastInstall,
    lastUninstall: host.lastUninstall,
    task: activeTask ? host.tasks.view(activeTask) : null,
  };
}

async function checkUpdate(host) {
  if (host.checkingNow) return policies.versionInfo(host, host.installedVersion());
  host.checkingNow = true;
  try {
    const installed = host.installedVersion();
    if (!installed) {
      host.lastCheck = { at: new Date().toISOString(), installed: null, latest: null, updateAvailable: false, note: 'not-installed' };
      return policies.versionInfo(host, installed);
    }
    const info = await host._latestVersion();
    const latest = info.ok ? info.version : null;
    host.lastCheck = {
      at: new Date().toISOString(), installed, latest,
      updateAvailable: latest ? policies.isNewer(latest, installed) : false,
      error: latest ? null : (info.error || '镜像源不可达或未查询到版本'),
    };
    if (host.events) host.events.append('version_checked', { installed, latest, updateAvailable: host.lastCheck.updateAvailable });
  } catch (e) {
    host.lastCheck = { ...(host.lastCheck || {}), at: new Date().toISOString(), installed: host.installedVersion(), error: e.message, updateAvailable: false };
    if (host.events) host.events.append('version_check_failed', { message: e.message });
  } finally {
    host.checkingNow = false;
  }
  return policies.versionInfo(host, host.installedVersion());
}

function beginTask(host, action, meta) {
  if (!host.tasks) return null;
  const task = host.tasks.begin('native', action, { id: 'main', name: '原生 DeepSeek Harness' }, meta);
  host.tasks.start(task.id);
  return task;
}

async function install(host, version) {
  if (!policies.isValidVersion(version)) return { ok: false, error: '非法版本号: ' + version };
  host.installing = true;
  host.installLog = [];
  let task = null;
  try {
    const env = await host.checkEnvironment();
    if (!env.ok) return { ok: false, error: '环境检查失败: ' + env.errors.join('; ') };
    task = beginTask(host, 'install', { to: version || null, createdBy: 'user' });
    let target = version;
    let registry = null;
    if (!target) {
      const info = await host._latestVersion().catch(() => null);
      if (!info || !info.ok || !info.version) {
        host.installing = null;
        const why = (info && info.error) || '无法从镜像源获取最新版本';
        if (task) host.tasks.fail(task.id, why);
        return { ok: false, error: why };
      }
      target = info.version;
      registry = info.origin;
    }
    if (!registry) registry = await host._selectRegistry();
    const pkg = host.config.packageName || PKG_DEFAULT;
    if (task) host.tasks.log(task.id, '安装 ' + pkg + '@' + target + (registry ? ' via ' + registry : ''));
    if (host.events) host.events.append('native_install_started', { version: target, registry });
    if (host.logger.info) host.logger.info('native install: ' + pkg + '@' + target + (registry ? ' via ' + registry : ''));
    const res = await host._runNpm({ action: 'install', version: target, registry });
    if (!res.ok) {
      host.installing = null;
      host.lastInstall = { ok: false, version: null, error: res.error, at: new Date().toISOString(), log: host.installLog.slice(-8) };
      if (host.events) host.events.append('native_install_failed', { error: res.error, output: res.output });
      if (task) host.tasks.fail(task.id, res.error);
      return { ok: false, error: res.error, output: res.output };
    }
    const isFirstInstall = !host._manifest();
    await host._recordManifest(target, isFirstInstall ? host._claimDataPaths() : undefined);
    try { if (typeof host._bindNativeDshCommand === 'function') host._bindNativeDshCommand(); }
    catch (e) { host.logger.warn && host.logger.warn('安装后原生绑定失败: ' + (e && e.message)); }
    const ver = host.installedVersion();
    host.installing = null;
    host.lastInstall = { ok: true, version: ver || target, error: null, at: new Date().toISOString(), log: host.installLog.slice(-8) };
    if (host.events) host.events.append('native_installed', { version: target });
    if (host.logger.info) host.logger.info('native installed: ' + (ver || target));
    if (task) { host.tasks.log(task.id, '安装完成，版本 ' + (ver || target)); host.tasks.succeed(task.id); }
    return { ok: true, version: ver || target };
  } finally {
    host.installing = null;
  }
}

function startInstall(host, version) {
  const g = policies.assertNotBusy(host, 'install');
  if (g) return g;
  if (!policies.isValidVersion(version)) return { ok: false, error: '非法版本号: ' + version };
  install(host, version).then(() => {}).catch((e) => {
    host.installing = null;
    host.lastInstall = { ok: false, version: null, error: e.message, at: new Date().toISOString(), log: host.installLog.slice(-8) };
    if (host.events) host.events.append('native_install_failed', { error: e.message });
    if (host.tasks) {
      try {
        const cur = host.tasks.current('native', 'main');
        if (cur && cur.action === 'install') host.tasks.fail(cur.id, '安装异常: ' + e.message);
      } catch {}
    }
    if (host.logger.error) host.logger.error('native install crashed: ' + e.message);
  });
  return { ok: true, started: true };
}

function startUninstall(host) {
  const g = policies.assertNotBusy(host, 'uninstall');
  if (g) return g;
  uninstall(host).then(() => {}).catch((e) => {
    host.uninstalling = null;
    host.lastUninstall = { ok: false, removed: [], error: e.message, at: new Date().toISOString() };
    if (host.events) host.events.append('native_uninstall_failed', { error: e.message });
    if (host.logger.error) host.logger.error('native uninstall crashed: ' + e.message);
  });
  return { ok: true, started: true };
}

async function uninstall(host) {
  const g = policies.assertNotBusy(host, 'uninstall');
  if (g) return g;

  host.uninstalling = true;
  try {
    if (host.events) host.events.append('native_uninstall_started', {});
    if (host.hooks && host.hooks.isDshActive && host.hooks.isDshActive()) {
      host._appendUpgradeLog('停止运行中的 DeepSeek Harness…');
      if (host.hooks.stopForUpgrade) await host.hooks.stopForUpgrade();
    }
    const m = host._manifest();
    const removed = [];
    const rm = (p) => {
      if (!p) return;
      try { fs.rmSync(p, { recursive: true, force: true }); removed.push(p); }
      catch (e) { host.logger.warn && host.logger.warn('uninstall 清理失败: ' + p + ' - ' + e.message); }
    };
    let task = null;
    if (host.tasks) {
      task = host.tasks.begin('native', 'uninstall', { id: 'main', name: '原生 DeepSeek Harness' }, { from: host.installedVersion(), createdBy: 'user' });
      host.tasks.start(task.id);
      host.tasks.log(task.id, '卸载 ' + (host.config.packageName || PKG_DEFAULT));
    }
    const res = await host._runNpm({ action: 'uninstall' });
    const exitCode = res.ok === true ? 0 : (Number.isFinite(res.exitCode) ? res.exitCode : -1);
    const timedOut = res.timedOut === true || res.aborted === true;
    if (exitCode === 0 && m) {
      if (m.packageDir) rm(m.packageDir);
      if (m.binPath) rm(m.binPath);
      for (const p of (m.dataPaths || [])) rm(p);
    }
    if (exitCode === 0) {
      rm(host.manifestFile);
    } else {
      host.logger.warn && host.logger.warn('npm uninstall exit ' + exitCode + '，保留 manifest 以便重试（数据路径未删）');
    }
    const uninstallError = exitCode === 0 ? null
      : (timedOut
        ? ((res.error || 'npm uninstall 超时已终止') + '，包可能仍在，可重试')
        : ('npm uninstall 退出码 ' + exitCode));
    host.lastUninstall = { ok: exitCode === 0, removed, error: uninstallError, timedOut, at: new Date().toISOString() };
    if (host.events) host.events.append('native_uninstalled', { removed });
    if (host.logger.info) host.logger.info('native uninstalled, removed ' + removed.length + ' paths');
    if (task) {
      if (exitCode === 0) { host.tasks.log(task.id, '卸载完成，清理 ' + removed.length + ' 个路径'); host.tasks.succeed(task.id); }
      else host.tasks.fail(task.id, uninstallError || ('npm uninstall 退出码 ' + exitCode));
    }
    return { ok: exitCode === 0, removed, timedOut, error: uninstallError };
  } finally {
    host.uninstalling = null;
  }
}

module.exports = { status, checkUpdate, install, startInstall, startUninstall, uninstall };
