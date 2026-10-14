'use strict';

const { createJobRecord, finishJobRecord, planJobCleanup, taskStateToJobState } = require('./model');

function createJobs({ tasks }) {
  const _jobs = {};
  const _scopeQueues = {};

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

  const finishJob = (job, ok, error) => {
    finishJobRecord(job, ok, error);
    if (tasks && job.taskId) {
      if (ok) { tasks.log(job.taskId, '完成'); tasks.succeed(job.taskId); }
      else tasks.fail(job.taskId, error || '任务失败');
    }
  };

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
