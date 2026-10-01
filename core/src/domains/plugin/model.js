'use strict';

const path = require('node:path');

const PROTECTED = new Set(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']);

const MAX_JOBS = 50;

function createJobRecord(kind, name, targetStr, targets) {
  const jobId = 'pj-' + Date.now() + '-' + Math.floor(Math.random() * 1000);
  return {
    id: jobId, kind, name, target: targetStr, state: 'running', startedAt: Date.now(), finishedAt: null, error: null,
    targets: targets.map((t) => ({ id: t.id, name: t.name, state: 'pending', log: [] })),
  };
}

function finishJobRecord(job, ok, error) {
  job.state = ok ? 'done' : 'failed';
  job.error = error || null;
  job.finishedAt = Date.now();
}

function planJobCleanup(ids, max = MAX_JOBS) {
  if (ids.length <= max) return [];
  return ids.slice(0, ids.length - max);
}

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

function ownerPackage(moduleName, bundles) {
  if (!moduleName || String(moduleName).startsWith('cordis:')) return null;
  for (const b of bundles) if (String(moduleName).includes(b)) return b;
  return null;
}

function targetHomePatchPath(target) {
  return path.resolve(path.dirname(path.dirname(target.profileDir)), 'cordis.patch.yml');
}

module.exports = {
  PROTECTED, createJobRecord, finishJobRecord, planJobCleanup, taskStateToJobState,
  isProtectedName, isOwnRow, isOwnDisabled, ownerPackage, targetHomePatchPath,
};
