'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { writeDurable } = require('../util/fs');

function loadTasks(file, onRecover) {
  if (!file) return null;
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
  if (!raw || !Array.isArray(raw.tasks)) return null;
  for (const t of raw.tasks) {
    if (t.state === 'running' || t.state === 'pending') {
      t.state = 'failed';
      t.error = t.error || '内核重启，任务中断';
      t.finishedAt = Date.now();
      if (onRecover) onRecover(t);
    }
  }
  return raw.tasks;
}

function readDiskTasks(file) {
  try {
    if (!fs.existsSync(file)) return null;
    const disk = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!disk || !Array.isArray(disk.tasks)) return null;
    return disk.tasks;
  } catch { return null; }
}

function writeTasks(file, tasks) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeDurable(file, JSON.stringify({ tasks }, null, 2), { mode: 0o600 });
}

// maxTasks 缺省兜底常量：调用方漏传时"上限"不得退化为不封顶。
const DEFAULT_MAX_TASKS = 200;

// 写盘不变式：合并 -> 按 startedAt 排序 -> 封顶，无条件执行。
// 排序键补 startedAt 缺省（磁盘上可能有早期无该字段的任务），否则比较恒为 0。
function capTasks(tasks, maxTasks) {
  const n = Number.isInteger(maxTasks) && maxTasks > 0 ? maxTasks : DEFAULT_MAX_TASKS;
  const sorted = tasks.slice().sort((a, b) => ((b && b.startedAt) || 0) - ((a && a.startedAt) || 0));
  return sorted.length > n ? sorted.slice(0, n) : sorted;
}

function saveTasks(file, tasks, maxTasks) {
  if (!file) return;
  let merged = tasks;
  const disk = readDiskTasks(file);
  if (disk) {
    const mine = new Map(tasks.map((t) => [t.id, t]));
    for (const t of disk) { if (t && t.id && !mine.has(t.id)) mine.set(t.id, t); }
    merged = Array.from(mine.values());
  }
  writeTasks(file, capTasks(merged, maxTasks));
}

module.exports = { loadTasks, saveTasks };
