'use strict';

// 统一安装/更新任务注册表：全部安装/升级/卸载/更新操作收敛到同一状态机
// pending -> running -> succeeded|failed|skipped|canceled，step 级进度 + 有界日志，持久化到 <产品状态根>/supervisor/tasks.json，守卫重启后仍可观测。
// canceled 为防御性识别态：全仓无取消生产者，_finish 仍接受该值、下游按 canceled -> failed 归类；不要再新增取消路径。

const path = require('node:path');
const taskStore = require('./task-store');

const MAX_TASKS = 200;      // 历史保留上限（超出清理最旧）
const MAX_LOG_LINES = 200;  // 单任务日志有界行数
const MAX_STEP_LOG = 30;    // 单 step 日志行数

/** 任务 id 生成（跨守卫重启唯一：时间戳 + 随机）。 */
function taskId() {
  return 'task-' + Date.now() + '-' + Math.floor(Math.random() * 1e6);
}

class TaskRegistry {
  constructor(opts) {
    this.stateDir = opts && opts.stateDir;
    this.logger = (opts && opts.logger) || null;
    this.events = (opts && opts.events) || null;
    this.file = this.stateDir ? path.join(this.stateDir, 'tasks.json') : null;
    this.tasks = [];      // 按创建时间倒序（最新在前）
    this._current = {};   // kind:target -> taskId（当前 running/pending 任务）
    this._load();
  }

  _log(lv, msg) {
    if (this.logger && this.logger[lv]) { try { this.logger[lv]('[tasks] ' + msg); } catch {} }
  }

  _emit(type, data) {
    if (this.events && this.events.append) { try { this.events.append(type, data); } catch {} }
  }

  /* 持久化 */
  _load() {
    const loaded = taskStore.loadTasks(this.file, (t) => this._log('warn', 'recovered interrupted task ' + t.id + ' as failed'));
    if (loaded) this.tasks = loaded;
  }

  _save() {
    if (!this.file) return;
    try { taskStore.saveTasks(this.file, this.tasks, MAX_TASKS); }
    catch (e) { this._log('error', 'tasks persist failed: ' + e.message); }
  }

  _cleanup() {
    if (this.tasks.length > MAX_TASKS) {
      this.tasks = this.tasks.slice(0, MAX_TASKS);
      this._save();
    }
  }

  /* 任务创建与查询 */
  begin(kind, action, target, opts) {
    const o = opts || {};
    const now = Date.now();
    const task = {
      id: taskId(),
      kind,
      action,
      target: { id: String(target.id), name: target.name || String(target.id) },
      from: o.from || null,
      to: o.to || null,
      state: 'pending',
      steps: [],
      error: null,
      log: [],
      startedAt: now,
      finishedAt: null,
      createdBy: o.createdBy || 'user',
      meta: o.meta || {},
    };
    this.tasks.unshift(task);
    this._current[kind + ':' + task.target.id] = task.id;
    this._save();
    this._cleanup();
    this._emit('task_created', { id: task.id, kind, action, target: task.target });
    this._log('info', 'task ' + task.id + ' created (' + kind + '/' + action + ' ' + task.target.id + ')');
    return task;
  }

  /** 统一作业执行器：begin->start->fn->succeed/fail 封装，作业体异常一律落 failed；
   *  finally 清 _current 索引，任务绝不永久占用。 */
  async run(kind, targetId, action, opts, fn) {
    if (this.isBusy(kind, targetId)) {
      const cur = this.current(kind, targetId);
      return { ok: false, error: '已有进行中任务', task: cur };
    }
    const task = this.begin(kind, action, { id: targetId }, opts);
    this.start(task.id);
    try {
      const result = await fn(task);
      const failed = result && typeof result === 'object' && result.ok === false;
      if (failed) this.fail(task.id, (result && result.error) || '任务失败');
      else this.succeed(task.id);
      return Object.assign({ ok: !failed, task: this.get(task.id) }, (result && typeof result === 'object') ? result : {});
    } catch (e) {
      this.fail(task.id, '作业异常: ' + ((e && e.message) || e));
      this._log('error', 'task ' + task.id + ' crashed: ' + ((e && e.stack) || e));
      return { ok: false, error: (e && e.message) || String(e), task: this.get(task.id) };
    } finally {
      // 仅当 _current 仍指向本任务且已终态才清索引（防止误删后继任务）
      const cur = this._current[kind + ':' + targetId];
      if (cur === task.id) {
        const t = this.get(task.id);
        if (!t || (t.state !== 'running' && t.state !== 'pending')) delete this._current[kind + ':' + targetId];
      }
    }
  }

  /** 目标当前是否已有运行中/排队任务。 */
  isBusy(kind, targetId) {
    const id = this._current[kind + ':' + targetId];
    if (!id) return false;
    const t = this.tasks.find((x) => x.id === id);
    return !!(t && (t.state === 'running' || t.state === 'pending'));
  }

  /** 目标当前运行中任务（无则 null）。 */
  current(kind, targetId) {
    const id = this._current[kind + ':' + targetId];
    if (!id) return null;
    const t = this.tasks.find((x) => x.id === id);
    return t && (t.state === 'running' || t.state === 'pending') ? t : null;
  }

  get(taskId) {
    return this.tasks.find((t) => t.id === taskId) || null;
  }
  /** 全部任务（按时间倒序）；可按 kind 过滤。 */
  list(kind) {
    if (kind) return this.tasks.filter((t) => t.kind === kind);
    return this.tasks;
  }

  /** 所有当前运行中任务（跨 kind）。 */
  running() {
    return this.tasks.filter((t) => t.state === 'running' || t.state === 'pending');
  }

  /* 任务推进 */
  start(taskId) {
    const t = this.get(taskId);
    if (!t || t.state !== 'pending') return null;
    t.state = 'running';
    this._save();
    this._emit('task_state', { id: taskId, state: 'running' });
    return t;
  }

  step(taskId, name) {
    const t = this.get(taskId);
    if (!t) return null;
    const s = { name, state: 'pending', ts: null, log: [] };
    t.steps.push(s);
    this._save();
    return s;
  }

  stepState(taskId, index, state, extra) {
    const t = this.get(taskId);
    if (!t || !t.steps[index]) return null;
    const s = t.steps[index];
    s.state = state;
    s.ts = Date.now();
    if (extra && extra.log) {
      s.log.push(extra.log);
      if (s.log.length > MAX_STEP_LOG) s.log.splice(0, s.log.length - MAX_STEP_LOG);
    }
    this._save();
    this._emit('task_step', { id: taskId, index, name: s.name, state });
    return s;
  }

  log(taskId, line) {
    const t = this.get(taskId);
    if (!t) return;
    const ts = new Date().toISOString().slice(11, 19);
    t.log.push('[' + ts + '] ' + line);
    if (t.log.length > MAX_LOG_LINES) t.log.splice(0, t.log.length - MAX_LOG_LINES);
    this._save();
  }

  succeed(taskId, extra) {
    return this._finish(taskId, 'succeeded', null, extra);
  }

  fail(taskId, error, extra) {
    return this._finish(taskId, 'failed', error, extra);
  }

  /** 任务跳过（无需执行，如已是最新）。 */
  skip(taskId, reason, extra) {
    return this._finish(taskId, 'skipped', reason, extra);
  }

  _finish(taskId, state, error, extra) {
    const t = this.get(taskId);
    if (!t || t.state === 'succeeded' || t.state === 'failed' || t.state === 'skipped' || t.state === 'canceled') return null;
    t.state = state;
    t.error = error || null;
    t.finishedAt = Date.now();
    if (extra && extra.meta) t.meta = Object.assign({}, t.meta, extra.meta);
    delete this._current[t.kind + ':' + t.target.id];
    this._save();
    this._emit('task_state', { id: taskId, state });
    this._log('info', 'task ' + taskId + ' -> ' + state + (error ? ' (' + error + ')' : ''));
    return t;
  }

  /* 视图 */
  /** 前端视图：安全字段（不暴露内部细节）。 */
  view(task) {
    if (!task) return null;
    return {
      id: task.id,
      kind: task.kind,
      action: task.action,
      target: task.target,
      from: task.from,
      to: task.to,
      state: task.state,
      error: task.error,
      steps: task.steps.map((s) => ({ name: s.name, state: s.state, ts: s.ts })),
      logTail: task.log.slice(-50),
      startedAt: task.startedAt,
      finishedAt: task.finishedAt,
      createdBy: task.createdBy,
      meta: task.meta,
    };
  }

  /** 概览：按 kind 聚合当前运行中任务。 */
  overview() {
    const cur = {};
    for (const t of this.running()) {
      cur[t.kind + ':' + t.target.id] = { id: t.id, action: t.action, state: t.state, to: t.to };
    }
    return { tasks: this.tasks.map((t) => this.view(t)), current: cur };
  }
}

module.exports = { TaskRegistry };
