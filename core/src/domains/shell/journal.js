'use strict';

const stateRoot = require('../../platform/service/state-root');

// 壳更新账本 / 状态机 / 健康上报（纯状态 + 本地 JSON 读写，不 spawn 进程、不查网），与版本检测/壳重启（restart.js）分离。
// 内核不是壳的更新源（壳直连 npm CDN 自更新），只读壳身份与更新账本、汇总状态供面板/CLI 查询；内核 Restart=always 常驻，是壳更新坏掉时唯一能救回的角色。
// 硬约束：绝不触碰内核既有更新机制 —— 只读壳产物/版本，不调用 runNpmInstall、不写内核版本状态；无预取、无缓存、无回退，只有 pending->confirmed 状态机。

const fs = require('node:fs');
const path = require('node:path');
const { writeAtomic } = require('../../platform/util/fs');
// deriveState 纯判定内核在 core.js。
const { deriveState } = require('./core');

// 状态目录与内核物理隔离，且独立于 ~/.dsh：内核 <状态根>/supervisor/，壳 <状态根>/shell/
//（单一事实源 = platform/service/state-root.js）。shellDir() 每次现读 DSH_SUPERVISOR_HOME，
// 故不在顶层固化路径。
function shellDir() {
  return stateRoot.shellDir();
}

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function writeJson(p, v) {
  const dir = path.dirname(p);
  fs.mkdirSync(dir, { recursive: true });
  writeAtomic(p, JSON.stringify(v, null, 2) + '\n', { mode: 0o600 });
}

// 壳身份：壳在启动最早期写入，内核只读 version/phase/exe/lastSeenAt 等运行时字段。
function identity() {
  return readJson(path.join(shellDir(), 'identity.json'));
}

// 更新账本：内核维护，权威。
function journalPath() { return path.join(shellDir(), 'update-journal.json'); }
function readJournal() {
  return readJson(journalPath()) || {
    from: null, to: null, confirmed: false,
    startedAt: null, lastAttemptAt: null,
  };
}
function writeJournal(j) { writeJson(journalPath(), j); }

/** 记录一次「壳更新已安装、待重启生效」。由壳侧上报（POST /shell/update-pending）或内核观察得到。*/
function markPending(from, to) {
  const j = readJournal();
  j.from = from || j.from;
  j.to = to;
  j.confirmed = false;
  j.startedAt = new Date().toISOString();
  writeJournal(j);
  return j;
}

/** 核心判定：读壳身份与账本两个快照，委托 core.deriveState（状态语义见该处，无回退判定）；
 *  仅当纯内核把账本从未确认翻转为已确认时显式落盘。 */
function evaluate() {
  const id = identity();
  const j = readJournal();
  const view = deriveState(id, j);
  if (view.state === 'confirmed' && j.confirmed !== true) writeJournal(view.journal);
  return view;
}

/** 仅回环可用的健康上报（壳调用）。phase=ready 即壳已健康启动 = 更新确认信号。 */
function health(payload) {
  const p = payload || {};
  const dir = shellDir();
  fs.mkdirSync(dir, { recursive: true });
  // 兜底写 identity.json 的 phase/version/lastSeenAt（壳自己也会写），供内核观察；
  // 本域 evaluate() 依赖它们。只写运行时字段。
  const idp = path.join(dir, 'identity.json');
  const id = readJson(idp) || {};
  if (p.phase) id.phase = String(p.phase);
  if (p.version) id.version = String(p.version);
  id.lastSeenAt = new Date().toISOString();
  writeJson(idp, id);

  const ev = evaluate();
  return { ok: true, phase: id.phase || null, state: ev.state, target: ev.target || null };
}

/** 汇总状态（供面板与 CLI）。 */
function status() {
  const id = identity();
  const ev = evaluate();
  const j = readJournal();
  return {
    identity: id,
    journal: j,
    state: ev.state,
    reason: ev.reason || null,
    dir: shellDir(),
  };
}

module.exports = { shellDir, identity, readJournal, markPending, evaluate, health, status };
