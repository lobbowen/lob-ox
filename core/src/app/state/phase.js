'use strict';

function legacyToEntryPhase(ph) {
  return { STOPPED: 'stopped', STARTING: 'starting', RUNNING: 'running', RESTARTING: 'restarting', BACKOFF: 'backoff', OBSERVED: 'stopped' }[ph] || 'stopped';
}

function entryToLegacyPhase(ph) {
  return { stopped: 'STOPPED', starting: 'STARTING', running: 'RUNNING', restarting: 'RESTARTING', backoff: 'BACKOFF' }[ph] || 'STOPPED';
}

module.exports = { legacyToEntryPhase, entryToLegacyPhase };
