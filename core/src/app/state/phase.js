'use strict';

function legacyToEntryPhase(ph) {
  return {
    STOPPED: 'stopped', STARTING: 'starting', RUNNING: 'running', FAILED: 'failed', OBSERVED: 'stopped',
    RESTARTING: 'starting', BACKOFF: 'failed',
  }[ph] || 'stopped';
}

function entryToLegacyPhase(ph) {
  return {
    stopped: 'STOPPED', starting: 'STARTING', running: 'RUNNING', failed: 'FAILED',
    restarting: 'STARTING', backoff: 'FAILED',
  }[ph] || 'STOPPED';
}

module.exports = { legacyToEntryPhase, entryToLegacyPhase };
