'use strict';

// main entry/process 字段表（纯数据，零依赖）。fields.js re-export 同名常量，可独立 require 断言。

const ENTRY_FIELDS = [
  // [读写 helper 后缀, entry 字段]
  ['CrashWindowStart', 'crashWindowStart'],
  ['CrashWindowRestarts', 'crashWindowRestarts'],
  ['BackoffLevel', 'backoffLevel'],
  ['BackoffUntil', 'backoffUntil'],
  ['RestartCount', 'restartCount'],
];

const PROC_FIELDS = [
  // [读写 helper 后缀, process 字段, 是否布尔]
  ['Child', 'child', false],
  ['AdoptPid', 'adoptedPid', false],
  ['Adopted', 'adopted', true],
  ['ObservedOnly', 'observedOnly', true],
  ['FailStreak', 'failStreak', false],
  ['RestartAt', 'restartAt', false],
  ['StartDeadline', 'startDeadline', false],
  ['SpawnBlockedUntil', 'spawnBlockedUntil', false],
  ['MissingNotified', 'missingNotified', true],
  ['LastProbeAt', 'lastProbeAt', false],
  ['LastProbeOk', 'lastProbeOk', false],
  ['LastProbeHttpOk', 'lastProbeHttpOk', false],
  ['LastFailure', 'lastFailure', false],
  ['LastRestartAt', 'lastRestartAt', false],
];

module.exports = { ENTRY_FIELDS, PROC_FIELDS };
