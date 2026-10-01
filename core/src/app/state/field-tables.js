'use strict';

const ENTRY_FIELDS = [
  ['StartupFailWindowStart', 'startupFailWindowStart'],
  ['StartupFailCount', 'startupFailCount'],
  ['RestartCount', 'restartCount'],
];

const PROC_FIELDS = [
  ['Child', 'child', false],
  ['AdoptPid', 'adoptedPid', false],
  ['Adopted', 'adopted', true],
  ['ObservedOnly', 'observedOnly', true],
  ['RestartAt', 'restartAt', false],
  ['StartDeadline', 'startDeadline', false],
  ['SpawnBlockedUntil', 'spawnBlockedUntil', false],
  ['MissingNotified', 'missingNotified', true],
  ['LastFailure', 'lastFailure', false],
  ['LastRestartAt', 'lastRestartAt', false],
];

module.exports = { ENTRY_FIELDS, PROC_FIELDS };
