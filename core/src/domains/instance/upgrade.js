'use strict';
const sandbox = require('./sandbox');
const model = require('./model');
const dshInstall = require('./ops/dsh-install');
const { DSH_PRODUCT } = require('../agent/model');
function taskLogger(task, tasks) {
  return (l) => { if (task) tasks.log(task.id, l); };
}

// 就绪判定只有一份实现：agent/ops/lifecycle.js 的 ready()（TCP 可达 + /healthz 2xx）。
// dist.waitPortHealthy 只判端口在听——那是必要不充分的条件，端口在听不代表可服务。
// 这里只负责轮询节奏，终态判定完全委托 ready()，不自行解释其返回值。
async function waitInstanceReady(inst, totalMs) {
  const agentLifecycle = require('../agent/ops/lifecycle');
  const deadline = Date.now() + (totalMs || 120000);
  let last = null;
  while (Date.now() < deadline) {
    last = await agentLifecycle.ready(inst.port, { timeoutMs: 2000 });
    if (last && last.state === 'ready') return { ok: true, state: last.state };
    await new Promise((r) => setTimeout(r, 1000));
  }
  return { ok: false, state: (last && last.state) || 'timeout' };
}

function createUpgrade(deps) {
  const { store, lifecycle, dist, tasks, logger, events, instancesRoot, agents } = deps;
  const save = () => store.save();
  const _updCache = {};
  const _updJobs = {};
  function _scheduleJobCleanup(id) {
    const t = setTimeout(() => {
      try { if (_updJobs[id] && _updJobs[id].state !== 'running') delete _updJobs[id]; } catch {}
      try { delete _updCache[id]; } catch {}
    }, 60000);
    if (t.unref) t.unref();
  }
  // agents 传入：安装/版本查询/latest 解析全部委托 agent 域，此处只保留相位与任务编排。
  const install = dshInstall.createDshInstall({ store, dist, tasks, logger, instancesRoot, agents });

  function installSandbox(inst) { return install.installSandbox(inst); }
  function readInstalledVersion(inst) { return install.readInstalledVersion(inst); }
  async function latestDsh() { return install.latestDsh(); }

  // versionInfo 只投影 _updCache，不再在每次 list() 里重新读盘。
  // installed 记在同一个缓存里，由「首次读取 / checkUpdate / 升级完成」写入；
  // latest 同样只来自 agent 域 checkUpdate 或升级完成（此前 _updCache 只在升级完成写入，
  // 正常运行期 latest 恒为 null，而 _checkUpdateLocal 又在生产不可达分支里自行查 npm）。
  function versionInfo(inst) {
    const cached = _updCache[inst.id];
    if (!cached || cached.installed === undefined) {
      // 惰性补一次并记住（读盘是一次性的，不是每次 list 都读）。
      cached_installed(inst);
    }
    const c = _updCache[inst.id];
    return { version: (c && c.installed) || null, latest: (c && c.latest) || null };
  }
  function cached_installed(inst) {
    const prev = _updCache[inst.id];
    if (!prev) _updCache[inst.id] = { installed: readInstalledVersion(inst), latest: null, checkedAt: 0, error: null };
    else if (prev.installed === undefined) prev.installed = readInstalledVersion(inst);
  }
  function jobView(inst) {
    const tAll = tasks ? tasks.list('instance') : [];
    const tt = tasks ? (tasks.current('instance', inst.id) || tAll.find((x) => x.target.id === inst.id) || null) : null;
    if (tt) {
      return {
        state: model.taskStateToView(tt.state),
        step: (tt.steps.length ? tt.steps[tt.steps.length - 1].name : 'preparing'),
        errors: tt.state === 'failed' ? 1 : 0,
        error: tt.error,
      };
    }
    const nj = _updJobs[inst.id];
    return nj ? { state: nj.state, step: nj.step, errors: nj.errors, error: nj.error } : null;
  }
  // R8-agent：「已装 vs 最新」只有 agent 域 checkUpdate 一处判据。
  // 生产装配 compose/domains.js 恒注入 agents；未注入时不再退回本地第二实现
  // （那是与 agent/status.js isNewer 重复的一份 semverCompare，且生产不可达），
  // 而是明确失败——「没有判据」不能被伪装成「有结果」。
  async function checkUpdate(id) {
    const inst = store.instances.find((i) => i.id === id);
    if (!inst) return { ok: false, error: '实例不存在' };
    if (inst.kind !== 'sandbox') return { ok: false, error: '仅沙箱实例支持版本检查' };
    if (!deps.agents) return { ok: false, error: 'agent 域未装配，无法执行版本检查' };
    const r = await deps.agents.checkUpdate(
      { id: 'sandbox:' + id, kind: 'sandbox', product: DSH_PRODUCT.pkg },
      { dist, installed: readInstalledVersion(inst), prefix: sandbox.installDir(instancesRoot, inst) }
    );
    _updCache[inst.id] = { installed: (r && r.installed) || null, latest: (r && r.latest) || null, checkedAt: Date.now(), error: (r && r.error) || null };
    if (events) events.append('inst_update_check', { id, installed: r.installed, latest: r.latest, updateAvailable: r.updateAvailable });
    return r;
  }

  // 经 agent 域安装指定版本到本实例的 prefix。
  // 保留 dist 直调作为 agents 未注入时的兜底（独立使用/测试）。
  async function installViaAgent(inst, version, registry, task) {
    const prefix = sandbox.installDir(instancesRoot, inst);
    const opts = {
      dist,
      prefix,
      version,
      registry: registry || null,
      onLine: taskLogger(task, tasks),
    };
    if (agents) {
      return agents.install(
        { id: 'sandbox:' + inst.id, kind: 'sandbox', product: DSH_PRODUCT.pkg, port: inst.port },
        opts
      );
    }
    return dist.runNpmInstall({
      pkg: DSH_PRODUCT.pkg, version, prefix, registry: opts.registry,
      onLine: taskLogger(task, tasks),
    });
  }
  async function upgradeInstance(id) {
    const inst = store.instances.find((i) => i.id === id);
    if (!inst) return { ok: false, error: '实例不存在' };
    if (inst.kind !== 'sandbox') return { ok: false, error: '仅沙箱实例支持升级' };
    const job = _updJobs[id];
    if (job && job.state === 'running') return { ok: true, jobId: id, already: true };
    if (tasks && tasks.isBusy('instance', id)) return { ok: true, jobId: id, already: true };
    const oldVersion = readInstalledVersion(inst);
    let task = null;
    if (tasks) {
      task = tasks.begin('instance', 'upgrade', { id, name: inst.name }, { from: oldVersion, to: null, createdBy: 'user' });
      tasks.start(task.id);
    }
    const nj = { state: 'running', startedAt: Date.now(), finishedAt: null, step: 'preparing', errors: 0, error: null };
    _updJobs[id] = nj;
    (async () => {
      const installDir = sandbox.installDir(instancesRoot, inst);
      let wasRunning = false;
      try { wasRunning = lifecycle.probe(inst).running; } catch {}
      if (wasRunning) {
        nj.step = 'stopping';
        if (task) { const s = tasks.step(task.id, '停止实例'); tasks.stepState(task.id, tasks.get(task.id).steps.indexOf(s), 'running'); }
        try { await lifecycle.stop(id); } catch {}
        if (task) { const t2 = tasks.get(task.id); const s2 = t2.steps[t2.steps.length - 1]; tasks.stepState(task.id, t2.steps.indexOf(s2), 'done'); }
      }
      nj.step = 'installing';
      if (task) { const s = tasks.step(task.id, '安装最新版'); tasks.stepState(task.id, tasks.get(task.id).steps.indexOf(s), 'running'); }
      const pick = await latestDsh();
      const targetVer = pick.version;
      const reg = pick.origin;
      if (task) tasks.log(task.id, '目标版本：' + (targetVer || '未知') + (reg ? '（源 ' + reg + '）' : ''));
      if (!targetVer) {
        const why = '无法获取最新版本：' + (pick.error || '未知原因');
        nj.errors++; nj.error = why; if (task) tasks.log(task.id, why);
      }
      else {
        if (!dist) { nj.errors++; nj.error = 'dist 分发服务不可用'; }
        else {
          // 安装本体委托 agent 域（installToPrefix）——原实现直接调 dist.runNpmInstall，
          // 与 agent/ops/upgrade.js 里那份是同一件事的两份实现。
          const res = await installViaAgent(inst, targetVer, reg, task);
          if (!res.ok) { nj.errors++; nj.error = res.error || 'npm install 失败'; if (task) tasks.log(task.id, res.error || 'npm install 失败'); }
        }
      }
      // 回滚的形态必须与「升级前」对称：wasRunning 为假说明实例本来就没在跑，
      // 此时无条件 stop 会把一个从未被停止的实例停掉（不对称回滚）。
      // wasRunning 因此是 rollback 的显式参数，不是闭包里的隐含假设。
      const rollback = async (why) => {
        if (!oldVersion) { if (task) tasks.log(task.id, '无旧版本可回滚，保持失败态'); return false; }
        if (task) { tasks.log(task.id, '自动回滚到 ' + oldVersion + '…'); }
        if (wasRunning) {
          try {
            const rs = await lifecycle.stop(id);
            if (rs && rs.ok === false && task) tasks.log(task.id, '回滚前停止失败（继续回装旧版）：' + (rs.error || ''));
          } catch (e) {
            if (task) tasks.log(task.id, '回滚前停止异常（继续回装旧版）：' + ((e && e.message) || e));
          }
        }
        let rbOk = false;
        if (dist) {
          try {
            const rbRes = await installViaAgent(inst, oldVersion, reg, task);
            rbOk = rbRes.ok;
          } catch { rbOk = false; }
        }
        if (!rbOk) { nj.error = (nj.error || why) + '；自动回滚失败（npm install 退出非 0），请手动处理'; return false; }
        // 与升级路径同理：实例原本没在跑，就不要因为回滚把它拉起来。
        if (!wasRunning) { nj.error = (nj.error || why) + '；已回滚到 ' + oldVersion + '（实例原未运行，保持停止）'; return false; }
        const rbStart = await lifecycle.start(id, { fromUpgrade: true }).catch(() => ({ ok: false }));
        if (!rbStart || !rbStart.ok) { nj.error = (nj.error || why) + '；回滚后重启也失败'; if (task) tasks.log(task.id, '回滚后重启失败：' + ((rbStart && rbStart.error) || '')); return false; }
        if (task) tasks.log(task.id, '回滚完成，版本 ' + (readInstalledVersion(inst) || '') + '，实例已重启');
        return true;
      };
      if (nj.errors) { nj.state = 'failed'; const rb = await rollback(nj.error); if (rb === false && oldVersion) nj.error = nj.error || '自动回滚未成功（见任务日志）'; }
      else {
        nj.step = 'restarting';
        if (task) { const s = tasks.step(task.id, '重启实例并验证'); tasks.stepState(task.id, tasks.get(task.id).steps.indexOf(s), 'running'); }
        const sr = await lifecycle.start(id, { fromUpgrade: true }).catch(() => ({ ok: false }));
        if (!sr || !sr.ok) { nj.errors++; nj.error = '升级后重启失败: ' + ((sr && sr.error) || ''); nj.state = 'failed'; const rb = await rollback(nj.error); if (rb === false && oldVersion) nj.error = nj.error || '自动回滚未成功（见任务日志）'; }
        else {
          let up = false;
          {
            const vh = await waitInstanceReady(inst, 120000);
            up = vh.ok;
          }
          if (!up) {
            nj.errors++;
            nj.error = '升级后实例未能启动（端口 ' + inst.port + ' 未就绪）';
            nj.state = 'failed';
            if (task) tasks.log(task.id, '实例启动失败：端口 ' + inst.port + ' 未就绪（详见 dsh.log / systemd 单元状态）');
            const rb = await rollback(nj.error); if (rb === false && oldVersion) nj.error = nj.error || '自动回滚未成功（见任务日志）';
          }
        }
        if (task && nj.state !== 'failed') { const t2 = tasks.get(task.id); const s2 = t2.steps[t2.steps.length - 1]; tasks.stepState(task.id, t2.steps.indexOf(s2), 'done'); }
      }
      if (nj.state !== 'failed') { nj.state = 'done'; }
      _updCache[id] = { installed: readInstalledVersion(inst), latest: targetVer || null, checkedAt: Date.now(), error: null };
      nj.finishedAt = Date.now();
      if (events) events.append('inst_upgraded', { id: inst.id, name: inst.name, ok: nj.state === 'done', error: nj.error });
      if (task) {
        if (nj.state === 'done') { tasks.log(task.id, '升级完成，版本 ' + (readInstalledVersion(inst) || '')); tasks.succeed(task.id); }
        else tasks.fail(task.id, nj.error || '升级失败');
      }
      save();
      _scheduleJobCleanup(id);
    })().catch((e) => {
      try { logger && logger.error && logger.error('upgrade job crashed ' + id + ': ' + (e && e.stack || e)); } catch {}
      if (nj.state === 'running') { nj.state = 'failed'; nj.error = '升级作业异常: ' + ((e && e.message) || e); nj.finishedAt = Date.now(); }
      try { if (task) tasks.fail(task.id, nj.error || ('升级作业异常: ' + ((e && e.message) || e))); } catch {}
      try { save(); } catch {}
      try { _scheduleJobCleanup(id); } catch {}
    });
    return { ok: true, jobId: id };
  }
  function upgradeStatus(id) {
    const all = tasks ? tasks.list('instance') : [];
    const t = tasks ? (tasks.current('instance', id) || all.find((x) => x.target.id === id) || null) : null;
    if (t) {
      return {
        state: model.taskStateToView(t.state),
        step: (t.steps.length ? t.steps[t.steps.length - 1].name : 'preparing'),
        errors: t.state === 'failed' ? 1 : 0,
        error: t.error,
        startedAt: t.startedAt,
        finishedAt: t.finishedAt,
        taskId: t.id,
      };
    }
    const job = _updJobs[id];
    if (!job) return { error: 'no upgrade job for ' + id };
    return { state: job.state, step: job.step, errors: job.errors, error: job.error, startedAt: job.startedAt, finishedAt: job.finishedAt };
  }
  return { _scheduleJobCleanup, installSandbox, readInstalledVersion, versionInfo, jobView, checkUpdate, upgradeInstance, upgradeStatus };
}
module.exports = { createUpgrade };
