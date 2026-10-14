'use strict';

function createInflight() {
  // 只保留 recordError 及其累加器：stats()/errorCount() 全仓零引用，
  // 为它们存在的 begun/ended 计数器也一并删除。
  let errors = 0;

  return {
    begin(acc) {
      if (!acc) return 0;
      acc.inflight = (acc.inflight || 0) + 1;
      return acc.inflight;
    },

    end(acc, ctx) {
      if (!acc) return { zero: false, effects: [] };
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
  };
}

module.exports = { createInflight };
