'use strict';

// 插件域作业服务（有状态，零出边指向 ops/updater/index，只依赖 model）：作业表（保留上限 50）+
// 作用域互斥队列 + 状态视图 + 统一任务注册表桥接（tasks 经 ctor 注入）。
// 互斥语义须逐字保持（异常不吞、调用方 .then 继续推进）：
//   prev.then(fn, fn) + 续链 run.catch(()=>{}) + 返回 run.catch(e=>({ok:false,error}))

const { createJobRecord, finishJobRecord, planJobCleanup, taskStateToJobState } = require('./model');

function createJobs({ tasks }) {
  const _jobs = {};          // jobId -> job（install/uninstall/update；兼容视图，桥接统一任务）
  const _scopeQueues = {};   // targetId -> Promise 链（作用域互斥）

  /** 作用域互斥：同目标串行。 */
  const withScopeLock = (targetId, fn) => {
    const prev = _scopeQueues[targetId] || Promise.resolve();
    const run = prev.then(fn, fn);
    _scopeQueues[targetId] = run.catch(() => {});
    return run.catch((e) => ({ ok: false, error: (e && e.message) || String(e) }));
  };

  const cleanupJobs = () => {
    const drop = planJobCleanup(Object.keys(_jobs));
    for (const id of drop) delete _jobs[id];
  };

  /** 新建作业并桥接统一任务（plugin/<kind>）。 */
  const createJob = (kind, name, targetStr, targets) => {
    const job = createJobRecord(kind, name, targetStr, targets);
    _jobs[job.id] = job;
    cleanupJobs();
    if (tasks) {
      const taskKind = kind === 'install' ? 'install' : (kind === 'update' ? 'update' : 'uninstall');
      const verb = kind === 'install' ? '安装插件 ' : (kind === 'update' ? '更新插件 ' : '卸载插件 ');
      const task = tasks.begin('plugin', taskKind, { id: targets[0] ? targets[0].id : 'native', name: targets[0] ? targets[0].name : targetStr }, { to: name, createdBy: 'user' });
      tasks.start(task.id);
      job.taskId = task.id;
      tasks.log(task.id, verb + name + '（目标 ' + targetStr + '）');
    }
    return job;
  };

  /** 作业收尾并桥接统一任务。 */
  const finishJob = (job, ok, error) => {
    finishJobRecord(job, ok, error);
    if (tasks && job.taskId) {
      if (ok) { tasks.log(job.taskId, '完成'); tasks.succeed(job.taskId); }
      else tasks.fail(job.taskId, error || '任务失败');
    }
  };

  /** 作业视图：任务存在时从 TaskRegistry 派生（单一事实源）。 */
  const installStatus = (jobId) => {
    const job = _jobs[jobId];
    if (job && job.taskId && tasks) {
      const t = tasks.get(job.taskId);
      if (t) {
        return {
          id: job.id, kind: job.kind, name: job.name, target: job.target,
          state: taskStateToJobState(t.state), startedAt: t.startedAt, finishedAt: t.finishedAt, error: t.error,
          targets: job.targets,
        };
      }
    }
    return job || { error: 'job not found' };
  };

  return { _jobs, _scopeQueues, withScopeLock, createJob, finishJob, installStatus };
}

module.exports = { createJobs };
