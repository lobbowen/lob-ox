'use strict';

const path = require('node:path');

// 插件域领域模型（纯，零 IO、零 this 协作）：内置保护名单 PROTECTED、作业记录形状与纯状态迁移
// （createJobRecord/finishJobRecord/planJobCleanup/taskStateToJobState）、补丁行与包名归属判定、
// home 补丁层路径推导。

/** 内置组件：禁止卸载/禁用（bind 进 store/ops 的判定）。 */
const PROTECTED = new Set(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']);

const MAX_JOBS = 50;

/** 新建作业记录：jobId + 每目标子记录（pending/log）。 */
function createJobRecord(kind, name, targetStr, targets) {
  const jobId = 'pj-' + Date.now() + '-' + Math.floor(Math.random() * 1000);
  return {
    id: jobId, kind, name, target: targetStr, state: 'running', startedAt: Date.now(), finishedAt: null, error: null,
    targets: targets.map((t) => ({ id: t.id, name: t.name, state: 'pending', log: [] })),
  };
}

/** 作业收尾：状态 + 错误 + 完成时刻（tasks 桥接由作业服务负责）。 */
function finishJobRecord(job, ok, error) {
  job.state = ok ? 'done' : 'failed';
  job.error = error || null;
  job.finishedAt = Date.now();
}

/** 计算超限需清理的 jobId（保留最新 MAX_JOBS 条）。 */
function planJobCleanup(ids, max = MAX_JOBS) {
  if (ids.length <= max) return [];
  return ids.slice(0, ids.length - max);
}

/** TaskRegistry 状态映射为作业视图状态（succeeded/skipped->done；failed/canceled->failed）。
 *  同一映射另有两处实现（有意平行，不抽公共函数）：domains/instance/model.js 的 taskStateToView、domains/router/ops/apps-registry.js 内联三元。
 *  改动本映射语义必须三处同批（跨域半改会让同一状态在插件/实例/应用视图上给出不同结果）。 */
function taskStateToJobState(s) {
  return (s === 'succeeded' || s === 'skipped') ? 'done'
    : (s === 'failed' || s === 'canceled') ? 'failed'
    : 'running';
}

function isProtectedName(name) { return PROTECTED.has(name); }

function isOwnRow(e, ids) {
  return e && typeof e === 'object' && typeof e.id === 'string' && ids.includes(e.id);
}

function isOwnDisabled(e, ids) {
  return isOwnRow(e, ids) && e.disabled === true;
}

/** 从模块说明符推断所属包名；cordis: 前缀为内置无主。 */
function ownerPackage(moduleName, bundles) {
  if (!moduleName || String(moduleName).startsWith('cordis:')) return null;
  for (const b of bundles) if (String(moduleName).includes(b)) return b;
  return null;
}

/** 目标 home 补丁层路径（DSH_HOME/cordis.patch.yml，由 profileDir 上溯两级）。 */
function targetHomePatchPath(target) {
  return path.resolve(path.dirname(path.dirname(target.profileDir)), 'cordis.patch.yml');
}

module.exports = {
  PROTECTED, createJobRecord, finishJobRecord, planJobCleanup, taskStateToJobState,
  isProtectedName, isOwnRow, isOwnDisabled, ownerPackage, targetHomePatchPath,
};
