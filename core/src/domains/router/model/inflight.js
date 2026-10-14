'use strict';

function createInflight() {
  let begun = 0;
  let ended = 0;
  let errors = 0;

  return {
    begin(acc) {
      if (!acc) return 0;
      begun += 1;
      acc.inflight = (acc.inflight || 0) + 1;
      return acc.inflight;
    },

    end(acc, ctx) {
      if (!acc) return { zero: false, effects: [] };
      ended += 1;
      acc.inflight = Math.max(0, (acc.inflight || 0) - 1);
      if (acc.inflight !== 0) return { zero: false, effects: [] };
      const c = ctx || {};
      const effects = [];
      if (c.lifecycle && acc._stopPendingUntilIdle) {
        effects.push({ kind: 'retryPendingStop', acc, prov: c.prov || null, inst: null });
      }
      if (c.lifecycle && c.inst) {
        effects.push({ kind: 'flushRestartPending', acc, prov: c.prov || null, inst: c.inst });
      }
      return { zero: true, effects };
    },

    recordError() { errors += 1; return errors; },
    errorCount() { return errors; },
    stats() { return { begun, ended, errors, active: begun - ended }; },
  };
}

module.exports = { createInflight };
