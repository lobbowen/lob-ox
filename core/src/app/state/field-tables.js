'use strict';

const ENTRY_FIELDS = [
  ['CrashWindowStart', 'crashWindowStart'],
  ['CrashWindowRestarts', 'crashWindowRestarts'],
  ['BackoffLevel', 'backoffLevel'],
  ['BackoffUntil', 'backoffUntil'],
  ['RestartCount', 'restartCount'],
];

const PROC_FIELDS = [
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
