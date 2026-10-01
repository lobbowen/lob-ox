'use strict';
const fs = require('node:fs');
const path = require('node:path');
const sandbox = require('../sandbox');

function createDshInstall(deps) {
  const { store, dist, tasks, logger, instancesRoot } = deps;
  const save = () => store.save();
  let _latestDsh = null;

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
      if (!dist) {
        inst.state.installOk = false; inst.state.installError = 'dist 分发服务不可用'; save();
        if (task) { try { tasks.fail(task.id, 'dist 分发服务不可用'); } catch {} }
        return { ok: false, error: 'dist 分发服务不可用' };
      }
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

  function readInstalledVersion(inst) {
    if (!inst || inst.domain !== 'sandbox') return null;
    try {
      const pkg = path.join(sandbox.nodeModulesDir(instancesRoot, inst), '@deepseek-ai', 'dsh', 'package.json');
      if (!fs.existsSync(pkg)) return null;
      const j = JSON.parse(fs.readFileSync(pkg, 'utf8'));
      return (j && typeof j.version === 'string') ? j.version : null;
    } catch { return null; }
  }

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
