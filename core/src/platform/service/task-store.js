'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { writeAtomic } = require('../util/fs');

function loadTasks(file, onRecover) {
  if (!file) return null;
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
  if (!raw || !Array.isArray(raw.tasks)) return null;
  for (const t of raw.tasks) {
    if (t.state === 'running' || t.state === 'pending') {
      t.state = 'failed';
      t.error = t.error || '守卫重启，任务中断';
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
  writeAtomic(file, JSON.stringify({ tasks }, null, 2), { mode: 0o600 });
}

function saveTasks(file, tasks, maxTasks) {
  if (!file) return;
  let merged = tasks;
  const disk = readDiskTasks(file);
  if (disk) {
    const mine = new Map(tasks.map((t) => [t.id, t]));
    for (const t of disk) { if (t && t.id && !mine.has(t.id)) mine.set(t.id, t); }
    merged = Array.from(mine.values());
    merged.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
    if (merged.length > maxTasks) merged = merged.slice(0, maxTasks);
  }
  writeTasks(file, merged);
}

module.exports = { loadTasks, saveTasks };
