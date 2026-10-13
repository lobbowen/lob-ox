'use strict';
const fs = require('node:fs');
const path = require('node:path');
const sandbox = require('../sandbox');
// 安装日志过滤/环形缓冲与 agent 域共用一份实现（原两份各自硬编码同一正则与 60 行上限）。
const { pushLog } = require('../../agent/ops/install');

function createDshInstall(deps) {
  const { store, dist, tasks, logger, instancesRoot, agents } = deps;
  const save = () => store.save();

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

  // 安装日志：噪声过滤 + 60 行环形缓冲 + 时间戳前缀收拢到 agent 域
  // ops/install.js 的 pushLog（原本这里内联了同一条正则与同一套上限）。
  // 行为保持：sink 指向 inst.state.installLog，放行的行仍写 tasks.log，仍每次落盘。
  function pushInstallLog(inst, task, txt) {
    if (!inst.state.installLog) inst.state.installLog = [];
    pushLog(inst.state.installLog, txt, (l) => {
      if (task) { try { tasks.log(task.id, l); } catch {} }
    });
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
        // 安装本体委托 agent 域（installToPrefix）：那里有 10min 超时、launcher 透传、
        // commandTemplate 与噪声过滤。原实现直接调 dist.runNpmInstall 并硬编码包名，
        // 与 agent 域的那份是同一件事的两份实现。
        res = agents
          ? await agents.install(
              { id: 'sandbox:' + inst.id, kind: 'sandbox', product: '@deepseek-ai/dsh', port: inst.port },
              { dist, prefix: installDir, version: latestVer, registry: pick.origin, onLine: pushLog }
            )
          : await dist.runNpmInstall({ pkg: '@deepseek-ai/dsh', version: latestVer, prefix: installDir, registry: pick.origin, onLine: pushLog });
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

  // 读已安装版本：委托 agent 域的 installedVersionAt（原实现自己拼 package.json 路径）。
  // prefix 用 sandbox.nodeModulesDir 的父目录（installDir）——installedVersionAt 内部
  // 会再拼 node_modules/<pkg>/package.json，与 agent 域同一判据。
  function readInstalledVersion(inst) {
    if (!inst || inst.kind !== 'sandbox') return null;
    const installDir = sandbox.installDir(instancesRoot, inst);
    return require('../../agent/ops/install').installedVersionAt(installDir, '@deepseek-ai/dsh');
  }

  // latest 解析：委托 agent 域的 createLatestResolver（TTL 30000 同值，
  // 原实现自己维护了一份缓存与 fetchNpmLatest 调用）。
  const _resolver = dist ? require('../../agent/ops/install').createLatestResolver(dist, {}) : null;
  async function latestDsh() {
    if (!_resolver) return { ok: false, version: null, origin: null, attempts: [], error: 'dist 分发服务不可用' };
    return _resolver('@deepseek-ai/dsh');
  }

  return { installSandbox, readInstalledVersion, latestDsh };
}

module.exports = { createDshInstall };
