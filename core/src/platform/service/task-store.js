'use strict';

// TaskRegistry 持久化（纯 IO）。loadTasks：读盘，running/pending 跨守卫重启视为 failed（进程已死）。
// saveTasks：落盘前重读磁盘并按 id 合并（多进程写者不丢数据），只写合并结果。
// 注意 tmp 名唯一：固定 .tmp 会让两个进程并发写同一临时文件，rename 出混合内容。

const fs = require('node:fs');
const path = require('node:path');
const { writeAtomic } = require('../util/fs');

/** 读回任务数组；文件缺失/损坏返回 null。中断任务经 onRecover 通知。 */
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

/** 读磁盘任务数组；缺失/损坏返回 null（调用方据此决定是否合并）。 */
function readDiskTasks(file) {
  try {
    if (!fs.existsSync(file)) return null;
    const disk = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!disk || !Array.isArray(disk.tasks)) return null;
    return disk.tasks;
  } catch { return null; }
}

/** 原子写（唯一 tmp 名）；失败抛错，由调用方记录。 */
function writeTasks(file, tasks) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeAtomic(file, JSON.stringify({ tasks }, null, 2), { mode: 0o600 });
}

/** 落盘：合并磁盘条目（同 id 以本方为准），创建时间倒序 + 上限截断，原子写。
 *  注意：只写合并结果，不写回 this.tasks，否则内存会混入另一进程的任务而索引未同步。 */
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
