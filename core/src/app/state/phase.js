'use strict';

const ENTRY_TO_LEGACY = {
  stopped: 'STOPPED',
  installing: 'INSTALLING',
  starting: 'STARTING',
  running: 'RUNNING',
  draining: 'STOPPING',
  failed: 'FAILED',
};

const LEGACY_TO_ENTRY = {
  STOPPED: 'stopped',
  INSTALLING: 'installing',
  STARTING: 'starting',
  RUNNING: 'running',
  STOPPING: 'draining',
  FAILED: 'failed',
  OBSERVED: 'stopped',
  RESTARTING: 'starting',
  BACKOFF: 'failed',
};

function entryToLegacyPhase(ph) {
  return ENTRY_TO_LEGACY[ph] || 'STOPPED';
}

function legacyToEntryPhase(ph) {
  return LEGACY_TO_ENTRY[ph] || 'stopped';
}

function isKnownEntry(ph) { return Object.prototype.hasOwnProperty.call(ENTRY_TO_LEGACY, ph); }
function isKnownLegacy(ph) { return Object.prototype.hasOwnProperty.call(LEGACY_TO_ENTRY, ph); }

module.exports = { entryToLegacyPhase, legacyToEntryPhase, isKnownEntry, isKnownLegacy };