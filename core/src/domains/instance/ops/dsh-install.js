'use strict';
// 沙箱 DSH 安装/检测（ops 叶子）：首次安装与升级共用同一条 npm install --prefix 路径，本模块负责安装与版本读/查。
// 协作方经 deps 显式注入；无隐式 this。
const fs = require('node:fs');
const path = require('node:path');
const sandbox = require('../sandbox');

function createDshInstall(deps) {
  const { store, dist, tasks, logger, instancesRoot } = deps;
  const save = () => store.save();
  let _latestDsh = null; // 最近一次**成功**的目标版本查询结果（含给出该版本的镜像源）

  /** 10min 装配看护回调：超时先呈现 FAILED(用户可见)，npm 慢网成功后自愈拉回 INSTALLING。 */
  function installTimeoutWatchdog(inst, task) {
    try {
      if (inst.state && inst.state.phase === 'INSTALLING') {
        inst.state.phase = 'FAILED';
        inst.state.installError = '安装超时(10分钟)';
        save();
        if (task) { try { tasks.log(task.id, '安装超时(10分钟)——等待安装进程收敛，成功则自动恢复'); } catch {} }
      }
    } catch (e2) { logger.error && logger.error('install watchdog ' + inst.id + ': ' + (e2 && e2.message)); }
  }

  /** 安装日志推送（过滤 npm 噪音；有界 + 作业日志镜像）。 */
  function pushInstallLog(inst, task, txt) {
    const t = new Date().toISOString().slice(11, 19);
    for (const ln of String(txt || '').split(/\r?\n/)) {
      const l = ln.trim();
      if (!l) continue;
      if (/unknown user config|npm warn|deprecated|^\$|npm notice/i.test(l)) continue;
      inst.state.installLog.push('[' + t + '] ' + l);
      if (inst.state.installLog.length > 60) inst.state.installLog.shift();
      if (task) { try { tasks.log(task.id, l); } catch {} }
    }
    save();
  }

  /** 在实例独立依赖目录完整安装 DeepSeek Harness（npm install @deepseek-ai/dsh）。
   *  装配以 TaskRegistry 作业承载；inst.state.install* 仅作前端镜像。返回 {ok,error}，失败不抛。 */
  async function installSandbox(inst) {
    let task = null;
    if (tasks) {
      try {
        if (tasks.isBusy('instance', inst.id)) return { ok: true, installing: true, already: true };
        task = tasks.begin('instance', 'install', { id: inst.id, name: inst.name }, { createdBy: 'user', meta: { domain: 'sandbox' } });
        tasks.start(task.id);
        const s0 = tasks.step(task.id, '安装 DeepSeek Harness（沙箱独立副本）');
        tasks.stepState(task.id, task.steps.indexOf(s0), 'running');
      } catch (e) { logger.warn && logger.warn('sandbox install task begin failed: ' + (e && e.message)); task = null; }
    }
    try {
      const installDir = sandbox.installDir(instancesRoot, inst);
      store.ensureDirs(inst);
      inst.state.phase = 'INSTALLING';
      inst.state.installAt = Date.now();
      inst.state.installOk = null;
      inst.state.installError = null;
      inst.state.installLog = inst.state.installLog || [];
      save();
      const pushLog = (txt) => pushInstallLog(inst, task, txt);
      if (task) { try { tasks.log(task.id, '目标目录：' + installDir); } catch {} }
      // 官方标准安装方式：npm install -g --prefix <沙箱目录> @deepseek-ai/dsh@<version>；必须显式携带
      // 最高版本号（npm 默认装 latest tag，可能不是最高版本）。镜像注入由 runNpmInstall 单点负责。
      if (!dist) {
        inst.state.installOk = false; inst.state.installError = 'dist 分发服务不可用'; save();
        if (task) { try { tasks.fail(task.id, 'dist 分发服务不可用'); } catch {} }
        return { ok: false, error: 'dist 分发服务不可用' };
      }
      // 下载源 = 给出这个版本的那个源：分开选会让「显示一个源、下载另一个源」重新分叉。
      const pick = await latestDsh();
      pushLog('安装目标版本：' + (pick.version || '未知') + (pick.origin ? '（源 ' + pick.origin + '）' : ''));
      if (!pick.version) {
        const why = '无法获取最新版本：' + (pick.error || '未知原因');
        inst.state.installOk = false; inst.state.installError = why; save();
        if (task) { try { tasks.fail(task.id, why); } catch {} }
        return { ok: false, error: why };
      }
      const latestVer = pick.version;
      const watchdog = setTimeout(() => installTimeoutWatchdog(inst, task), 10 * 60 * 1000);
      let res;
      try {
        res = await dist.runNpmInstall({ pkg: '@deepseek-ai/dsh', version: latestVer, prefix: installDir, registry: pick.origin, onLine: pushLog });
      } finally {
        clearTimeout(watchdog);
      }
      inst.state.installOk = res.ok;
      if (!res.ok) { inst.state.installError = res.error; logger.error('sandbox install failed for ' + inst.id + ': ' + res.error); }
      // 竞态自愈：await 期间看护可能已置 FAILED；若实际成功则恢复 INSTALLING 让监督拍立即拉起。
      if (res.ok && inst.state.phase === 'FAILED' && inst.state.installError && /安装超时/.test(inst.state.installError || '')) {
        inst.state.phase = 'INSTALLING';
        inst.state.installError = null;
      }
      save();
      const doneMeta = { meta: { version: latestVer } };
      if (task) {
        try {
          if (res.ok) tasks.succeed(task.id, doneMeta);
          else tasks.fail(task.id, res.error || '安装失败');
        } catch (e2) { logger.warn && logger.warn('sandbox install task finish failed: ' + (e2 && e2.message)); }
      }
      return { ok: res.ok, installing: res.ok, error: res.ok ? null : (res.error || '安装失败') };
    } catch (e) {
      if (task) { try { tasks.fail(task.id, (e && e.message) || '安装异常'); } catch (e2) {} }
      logger.error && logger.error('sandbox install failed for ' + inst.id + ': ' + (e && e.message));
      return { ok: false, error: (e && e.message) || String(e) };
    }
  }

  /** 读取沙箱实例已安装的 DSH 版本（其独立 install 目录的 package.json，同步读盘不查网）。 */
  function readInstalledVersion(inst) {
    if (!inst || inst.domain !== 'sandbox') return null;
    try {
      const pkg = path.join(sandbox.nodeModulesDir(instancesRoot, inst), '@deepseek-ai', 'dsh', 'package.json');
      if (!fs.existsSync(pkg)) return null;
      const j = JSON.parse(fs.readFileSync(pkg, 'utf8'));
      return (j && typeof j.version === 'string') ? j.version : null;
    } catch { return null; }
  }

  /** 查询 @deepseek-ai/dsh 的目标版本与给出该版本的镜像源（dist 侧候选顺延 + 逐源失败原因）。
   *  只缓存**成功**结果：缓存失败会让面板在 TTL 内一直复述同一个错误结论。
   *  不取 registry 全量最高：会把他人杂 tag 当候选；第三方包 latest 优先语义单源在 dist.fetchNpmLatest。 */
  async function latestDsh() {
    if (_latestDsh && Date.now() - _latestDsh.at < 30000) return _latestDsh;
    let r = { ok: false, version: null, origin: null, attempts: [], error: 'dist 分发服务不可用' };
    if (dist) {
      try { r = await dist.fetchNpmLatest('@deepseek-ai/dsh'); }
      catch (e) { r = { ok: false, version: null, origin: null, attempts: [], error: (e && e.message) || String(e) }; }
    }
    if (r.ok && r.version) _latestDsh = Object.assign({ at: Date.now() }, r);
    return r;
  }

  return { installSandbox, readInstalledVersion, latestDsh };
}

module.exports = { createDshInstall };
