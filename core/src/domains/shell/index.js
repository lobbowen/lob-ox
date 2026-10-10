'use strict';

const {
  shellDir,
  identity,
  readJournal,
  markPending,
  evaluate,
  health,
  status,
} = require('./journal');

// 注意：restartShell / checkUpdate / SHELL_RELEASE_PKG 已迁至壳（Rust 底座）。
// 内核对壳仅做只读聚合：status/evaluate/health/markPending/identity/readJournal/shellDir。
module.exports = { status, evaluate, health, markPending, identity, readJournal, shellDir };
