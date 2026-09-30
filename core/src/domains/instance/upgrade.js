'use strict';
// 沙箱 DSH 安装/检测/升级：首次安装与升级走同一条 npm install --prefix 路径（同写实例独立 install 目录、同镜像源、都经 TaskRegistry 作业承载）。
// 协作方（store/lifecycle/dist/tasks）经 deps 显式注入；无隐式 this。
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
  const _updCache = {};                 // id -> { latest, checkedAt, error }
  const _updJobs = {};                  // id -> { state, startedAt, finishedAt, step, errors, error }
  const _updTTL = 6 * 3600 * 1000;      // 缓存 6h；升级作业收尾时 _scheduleJobCleanup 删缓存，下一次检查即重新查询
  /** 升级作业收尾清理：完成后保留 60s 供前端轮询，随后删除 _updJobs 与 _updCache（否则长寿命守卫下 _updCache 只写不删、内存单调增长）；定时器 unref 不拖住进程退出。 */
  function _scheduleJobCleanup(id) {
    const t = setTimeout(() => {
      try { if (_updJobs[id] && _updJobs[id].state !== 'running') delete _updJobs[id]; } catch {}
      try { delete _updCache[id]; } catch {}
    }, 60000);
    if (t.unref) t.unref();
  }
  // 安装/版本叶子（DF-7：upgrade 编排到 ops 叶子；单向）
  const install = dshInstall.createDshInstall({ store, dist, tasks, logger, instancesRoot });

  function installSandbox(inst) { return install.installSandbox(inst); }
  function readInstalledVersion(inst) { return install.readInstalledVersion(inst); }
  async function latestDsh() { return install.latestDsh(); }

  /** 视图行所需的版本信息（纯读，供 ops.list 组装）。 */
  function versionInfo(inst) {
    const cached = _updCache[inst.id];
    return { version: readInstalledVersion(inst), latest: (cached && cached.latest) || null };
  }
  /** 视图行所需的更新作业视图（TaskRegistry current 优先，无任务环境回退 _updJobs）。 */
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
  /** 检查某沙箱实例是否有更新：npm 查最新版并缓存 6h（缓存新鲜时直接复用，不强制刷新）。 */
  async function checkUpdate(id) {
    const inst = store.instances.find((i) => i.id === id);
    if (!inst) return { ok: false, error: '实例不存在' };
    if (inst.domain !== 'sandbox') return { ok: false, error: '仅沙箱实例支持版本检查' };
    const installed = readInstalledVersion(inst);
    const cached = _updCache[id];
    let latest = (cached && cached.latest) || null;
    if (!latest || !cached || (Date.now() - cached.checkedAt) > _updTTL) {
      try {
        // 结构化查询：只有「确实取不到」才写失败，且把逐源原因带出去——只回「查询失败」时
        // 用户与运维都无法区分「镜像源全挂」与「这个包真的没更新」。
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
  /** 升级沙箱实例 DSH：stop(若在跑)，安装，重启并验证，succeeded/failed；失败自动回滚。
   *  同一实例升级中重复调用返回 already。 */
  async function upgradeInstance(id) {
    const inst = store.instances.find((i) => i.id === id);
    if (!inst) return { ok: false, error: '实例不存在' };
    if (inst.domain !== 'sandbox') return { ok: false, error: '仅沙箱实例支持升级' };
    const job = _updJobs[id];
    // 并发互斥（勿拆散）：检查与 _updJobs[id]=running 置位之间没有任何 await（同步完成），
    // 因此第二个并发调用必然看到 state==='running' 被拦截——同一实例绝无双 npm install。
    if (job && job.state === 'running') return { ok: true, jobId: id, already: true };
    if (tasks && tasks.isBusy('instance', id)) return { ok: true, jobId: id, already: true };
    const oldVersion = readInstalledVersion(inst); // 升级前版本（自动回滚目标）
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
      // 1) 运行中先停（升级期间不跑旧版；tick 见 STOPPED 不干预）
      if (wasRunning) {
        nj.step = 'stopping';
        if (task) { const s = tasks.step(task.id, '停止实例'); tasks.stepState(task.id, tasks.get(task.id).steps.indexOf(s), 'running'); }
        try { await lifecycle.stop(id); } catch {}
        if (task) { const t2 = tasks.get(task.id); const s2 = t2.steps[t2.steps.length - 1]; tasks.stepState(task.id, t2.steps.indexOf(s2), 'done'); }
      }
      // 2) 强制重装最新版（与首次安装同命令、同镜像源；npm 自会覆盖旧版本）。必须显式携带最高版本号。
      nj.step = 'installing';
      if (task) { const s = tasks.step(task.id, '安装最新版'); tasks.stepState(task.id, tasks.get(task.id).steps.indexOf(s), 'running'); }
      // 下载源与回滚源都取「给出目标版本的那个源」：另选一次会让版本与字节来自两个不同镜像。
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
      // 三条失败路径（npm 安装失败/重启失败/端口未就绪）必须共用同一个回滚，否则一次失败升级
      // 等于实例停机加版本不确定（guardian 也不自愈，只能人工处理）。
      const rollback = async (why) => {
        if (!oldVersion) { if (task) tasks.log(task.id, '无旧版本可回滚，保持失败态'); return false; }
        if (task) { tasks.log(task.id, '自动回滚到 ' + oldVersion + '…'); }
        // 回滚前先停新版本单元：失败路径 3（新版本已启动但健康验证未过）里进程可能仍监听端口，
        // 不停则旧版重启会被 _systemdStart 的「端口已被占用」拒绝，磁盘回旧版而内存仍跑新版。
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
        // 不写 inst.state.version：全仓无读取（版本经 readInstalledVersion 实时读盘），多余字段只会污染 instances.json。
        if (!rbOk) { nj.error = (nj.error || why) + '；自动回滚失败（npm install 退出非 0），请手动处理'; return false; }
        const rbStart = await lifecycle.start(id, { fromUpgrade: true }).catch(() => ({ ok: false }));
        if (!rbStart || !rbStart.ok) { nj.error = (nj.error || why) + '；回滚后重启也失败'; if (task) tasks.log(task.id, '回滚后重启失败：' + ((rbStart && rbStart.error) || '')); return false; }
        if (task) tasks.log(task.id, '回滚完成，版本 ' + (readInstalledVersion(inst) || '') + '，实例已重启');
        return true;
      };
      if (nj.errors) { nj.state = 'failed'; await rollback(nj.error); }
      else {
        nj.step = 'restarting';
        // 3) 拉回实例并验证可启动（防显示成功但实例起不来）：DSH 可能先监听端口后因插件兼容崩溃，
        //    健康验证须端口 + systemd 单元 active 双查；无论升级前是否在跑都验证。
        if (task) { const s = tasks.step(task.id, '重启实例并验证'); tasks.stepState(task.id, tasks.get(task.id).steps.indexOf(s), 'running'); }
        const sr = await lifecycle.start(id, { fromUpgrade: true }).catch(() => ({ ok: false }));
        if (!sr || !sr.ok) { nj.errors++; nj.error = '升级后重启失败: ' + ((sr && sr.error) || ''); nj.state = 'failed'; await rollback(nj.error); }
        else {
          let up = false;
          if (dist) {
            // 验证窗口 120s：配合 waitPortHealthy 的稳定期复检，防慢启动实例被误判失败。
            const vh = await dist.waitPortHealthy(portHealthOpts(inst));
            up = vh.ok;
          }
          if (!up) {
            nj.errors++;
            // 只陈述可观测事实，把诊断留给日志（dsh.log / systemctl status）。
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
      // RC4 执行契约兜底：作业体任何 reject 必达终态——任务落 failed、_updJobs 释放，绝不永久 running。
      try { logger && logger.error && logger.error('upgrade job crashed ' + id + ': ' + (e && e.stack || e)); } catch {}
      if (nj.state === 'running') { nj.state = 'failed'; nj.error = '升级作业异常: ' + ((e && e.message) || e); nj.finishedAt = Date.now(); }
      try { if (task) tasks.fail(task.id, nj.error || ('升级作业异常: ' + ((e && e.message) || e))); } catch {}
      try { save(); } catch {}
      try { _scheduleJobCleanup(id); } catch {}
    });
    return { ok: true, jobId: id };
  }
  /** 升级进度查询（前端轮询；单一事实源 = TaskRegistry，无任务环境回退 _updJobs）。 */
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
