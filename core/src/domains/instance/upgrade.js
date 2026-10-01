'use strict';
const { semverCompare } = require('../../shared/version');
const sandbox = require('./sandbox');
const model = require('./model');
const dshInstall = require('./ops/dsh-install');
function taskLogger(task, tasks) {
  return (l) => { if (task) tasks.log(task.id, l); };
}

function portHealthOpts(inst) {
  return { host: '127.0.0.1', port: inst.port, unit: 'dsh-web@' + inst.id, timeoutMs: 120000 };
}

function createUpgrade(deps) {
  const { store, lifecycle, dist, tasks, logger, events, instancesRoot } = deps;
  const save = () => store.save();
  const _updCache = {};
  const _updJobs = {};
  const _updTTL = 6 * 3600 * 1000;
  function _scheduleJobCleanup(id) {
    const t = setTimeout(() => {
      try { if (_updJobs[id] && _updJobs[id].state !== 'running') delete _updJobs[id]; } catch {}
      try { delete _updCache[id]; } catch {}
    }, 60000);
    if (t.unref) t.unref();
  }
  const install = dshInstall.createDshInstall({ store, dist, tasks, logger, instancesRoot });

  function installSandbox(inst) { return install.installSandbox(inst); }
  function readInstalledVersion(inst) { return install.readInstalledVersion(inst); }
  async function latestDsh() { return install.latestDsh(); }

  function versionInfo(inst) {
    const cached = _updCache[inst.id];
    return { version: readInstalledVersion(inst), latest: (cached && cached.latest) || null };
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
  async function checkUpdate(id) {
    const inst = store.instances.find((i) => i.id === id);
    if (!inst) return { ok: false, error: '实例不存在' };
    if (inst.domain !== 'sandbox') return { ok: false, error: '仅沙箱实例支持版本检查' };
    const installed = readInstalledVersion(inst);
    const cached = _updCache[id];
    let latest = (cached && cached.latest) || null;
    if (!latest || !cached || (Date.now() - cached.checkedAt) > _updTTL) {
      try {
        const pick = await dist.fetchNpmLatest('@deepseek-ai/dsh');
        latest = pick.ok ? pick.version : null;
        _updCache[id] = { latest, checkedAt: Date.now(), error: pick.ok ? null : (pick.error || '查询失败') };
      } catch (e) {
        latest = null;
        _updCache[id] = { latest: null, checkedAt: Date.now(), error: e.message };
      }
    }
    const updateAvailable = !!(latest && installed && semverCompare(latest, installed) > 0);
    if (events) events.append('inst_update_check', { id, installed, latest, updateAvailable });
    return { ok: true, installed, latest, updateAvailable, error: _updCache[id].error };
  }
  async function upgradeInstance(id) {
    const inst = store.instances.find((i) => i.id === id);
    if (!inst) return { ok: false, error: '实例不存在' };
    if (inst.domain !== 'sandbox') return { ok: false, error: '仅沙箱实例支持升级' };
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
          const res = await dist.runNpmInstall({
            pkg: '@deepseek-ai/dsh', version: targetVer, prefix: installDir, registry: reg,
            onLine: taskLogger(task, tasks),
          });
          if (!res.ok) { nj.errors++; nj.error = res.error || 'npm install 失败'; if (task) tasks.log(task.id, res.error || 'npm install 失败'); }
        }
      }
      const rollback = async (why) => {
        if (!oldVersion) { if (task) tasks.log(task.id, '无旧版本可回滚，保持失败态'); return false; }
        if (task) { tasks.log(task.id, '自动回滚到 ' + oldVersion + '…'); }
        // 回滚前必须先停新版本单元：否则旧版重启被「端口已被占用」拒绝，磁盘回旧而内存仍跑新版。
        try {
          const rs = await lifecycle.stop(id);
          if (rs && rs.ok === false && task) tasks.log(task.id, '回滚前停止失败（继续回装旧版）：' + (rs.error || ''));
        } catch (e) {
          if (task) tasks.log(task.id, '回滚前停止异常（继续回装旧版）：' + ((e && e.message) || e));
        }
        const rbOpts = {
          pkg: '@deepseek-ai/dsh', version: oldVersion, prefix: installDir, registry: reg,
          onLine: taskLogger(task, tasks),
        };
        let rbOk = false;
        if (dist) {
          try {
            const rbRes = await dist.runNpmInstall(rbOpts);
            rbOk = rbRes.ok;
          } catch { rbOk = false; }
        }
        if (!rbOk) { nj.error = (nj.error || why) + '；自动回滚失败（npm install 退出非 0），请手动处理'; return false; }
        const rbStart = await lifecycle.start(id, { fromUpgrade: true }).catch(() => ({ ok: false }));
        if (!rbStart || !rbStart.ok) { nj.error = (nj.error || why) + '；回滚后重启也失败'; if (task) tasks.log(task.id, '回滚后重启失败：' + ((rbStart && rbStart.error) || '')); return false; }
        if (task) tasks.log(task.id, '回滚完成，版本 ' + (readInstalledVersion(inst) || '') + '，实例已重启');
        return true;
      };
      if (nj.errors) { nj.state = 'failed'; await rollback(nj.error); }
      else {
        nj.step = 'restarting';
        if (task) { const s = tasks.step(task.id, '重启实例并验证'); tasks.stepState(task.id, tasks.get(task.id).steps.indexOf(s), 'running'); }
        const sr = await lifecycle.start(id, { fromUpgrade: true }).catch(() => ({ ok: false }));
        if (!sr || !sr.ok) { nj.errors++; nj.error = '升级后重启失败: ' + ((sr && sr.error) || ''); nj.state = 'failed'; await rollback(nj.error); }
        else {
          let up = false;
          if (dist) {
            const vh = await dist.waitPortHealthy(portHealthOpts(inst));
            up = vh.ok;
          }
          if (!up) {
            nj.errors++;
            nj.error = '升级后实例未能启动（端口 ' + inst.port + ' 未就绪）';
            nj.state = 'failed';
            if (task) tasks.log(task.id, '实例启动失败：端口 ' + inst.port + ' 未就绪（详见 dsh.log / systemd 单元状态）');
            await rollback(nj.error);
          }
        }
        if (task && nj.state !== 'failed') { const t2 = tasks.get(task.id); const s2 = t2.steps[t2.steps.length - 1]; tasks.stepState(task.id, t2.steps.indexOf(s2), 'done'); }
      }
      if (nj.state !== 'failed') { nj.state = 'done'; }
      _updCache[id] = { latest: targetVer || readInstalledVersion(inst) || null, checkedAt: Date.now(), error: null };
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
