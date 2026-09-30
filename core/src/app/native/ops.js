'use strict';

// 域：原生 DSH（app/native）—— 安装/卸载/状态/更新检查编排。
// 纯编排：npm 动作一律经 host._runNpm 下沉到 platform/distribution 的执行器，本文件不自持子进程。

const fs = require('node:fs');
const policies = require('./policies');

const PKG_DEFAULT = '@deepseek-ai/dsh';

/** 安装状态（含版本 + 任务进度，供前端即时渲染）。 */
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

/** 版本检测：未安装时静默；已安装时比较最新版（网络故障与「无更新」如实区分）。 */
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
      // 拒因指名到源：「镜像源全挂」与「确实没有更新」显示成两句话是这块的全部意义。
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

/** 开统一任务（install/uninstall 共用）。 */
function beginTask(host, action, meta) {
  if (!host.tasks) return null;
  const task = host.tasks.begin('native', action, { id: 'main', name: '原生 DeepSeek Harness' }, meta);
  host.tasks.start(task.id);
  return task;
}

/** 安装执行（安装/升级/回滚共用 `_runNpm` 出口）。 */
async function install(host, version) {
  if (!policies.isValidVersion(version)) return { ok: false, error: '非法版本号: ' + version };
  // 并发锁必须在任何 await 之前置位（否则并发 POST 会在 await 间隙同时通过检查）。
  //   环境检查已改异步（exec 冻结收口），故排在锁之后、进临界区，由 finally 统一释放。
  host.installing = true;
  host.installLog = [];
  // 锁释放统一走 finally：锁一旦滞留，startInstall/startUninstall 与升级的并发闸
  //   会永久拒绝全部安装类操作。分支内的显式置 null 只是冗余保险，权威释放点是 finally。
  let task = null;
  try {
    const env = await host.checkEnvironment();
    if (!env.ok) return { ok: false, error: '环境检查失败: ' + env.errors.join('; ') };
    task = beginTask(host, 'install', { to: version || null, createdBy: 'user' });
    let target = version;
    let registry = null;
    if (!target) {
      // 目标版本与下载源**同源**：分开各选一次会让「A 源查到的版本」从「B 源」下载，
      // B 恰好没有这个版本时表现为安装失败，而面板显示的镜像是 B —— 诊断指向错的那个源。
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
    // 调用方钉死了版本时没有查询发生过，源仍需选一次。
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
    // 数据认领：仅首装（manifest 尚不存在）尝试；~/.dsh 已有用户数据时不认领（防误删）。
    // 升级/重装绝不能传 []：manifest.record 的继承分支判据是「未显式传 dataPaths」，
    //   传空数组会把上一代认领记录抹成 []，卸载清理从此静默失效、目录永久残留。
    const isFirstInstall = !host._manifest();
    await host._recordManifest(target, isFirstInstall ? host._claimDataPaths() : undefined);
    // 安装成功后立即复跑「检测 -> 绑定」：裸 config.command 首装后若不绑定，
    //   DSH 永不起、冷静期无限循环，直到守卫重启。
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

/** 启动安装（API 用）：同步前置检查，通过则后台执行并立即返回（进度经 status 轮询）。
 *  环境检查是异步探测，已移入 install() 锁内第一步：环境失败不再同步返回，
 *  而经 status 的 lastInstall 呈现——返回时序变了，能力不减。 */
function startInstall(host, version) {
  if (host.installing) return { ok: false, error: '安装已在进行中' };
  if (host.uninstalling) return { ok: false, error: '卸载进行中，请稍后再装' };
  if (policies.busy(host)) return { ok: false, error: '升级进行中，请稍后再装（state=' + host.upgradeState + '）' };
  if (!policies.isValidVersion(version)) return { ok: false, error: '非法版本号: ' + version };
  install(host, version).then(() => {}).catch((e) => {
    // 后台任务意外抛错：复位标志并兜底任务注册表（防任务永久 running 占锁）。
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

/** 启动卸载（API 用）：同步前置检查 + 后台执行，立即返回。 */
function startUninstall(host) {
  if (host.installing) return { ok: false, error: '安装进行中，无法卸载' };
  if (host.uninstalling) return { ok: false, error: '卸载已在进行中' };
  if (policies.busy(host)) return { ok: false, error: '升级进行中，无法卸载（state=' + host.upgradeState + '）' };
  uninstall(host).then(() => {}).catch((e) => {
    host.uninstalling = null;
    host.lastUninstall = { ok: false, removed: [], error: e.message, at: new Date().toISOString() };
    if (host.events) host.events.append('native_uninstall_failed', { error: e.message });
    if (host.logger.error) host.logger.error('native uninstall crashed: ' + e.message);
  });
  return { ok: true, started: true };
}

/** 卸载：npm 动作经统一执行器（超时看门狗 / 杀进程树 / 在途记账都在那侧），本函数只管
 *  应用层状态：锁、任务、manifest 清理与 K10（失败保留 manifest 以便重试）。
 *  锁释放由 finally 结构保证（含异常路径）。 */
async function uninstall(host) {
  if (host.tasks && host.tasks.isBusy('native', 'main')) return { ok: false, error: '已有任务在进行中' };
  if (host.installing) return { ok: false, error: '安装进行中，无法卸载' };
  if (host.uninstalling) return { ok: false, error: '卸载已在进行中' };
  if (policies.busy(host)) return { ok: false, error: '升级进行中，无法卸载（state=' + host.upgradeState + '）' };

  host.uninstalling = true;
  try {
    if (host.events) host.events.append('native_uninstall_started', {});
    // 先停运行中的 DSH：运行进程中直接删包/数据文件会懒加载崩溃。
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
    // 卸载失败时不得删除 manifest：保留以便重试与如实上报。
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
