'use strict';

function shouldGuard(inst) {
  return !!(inst && inst.guardian === true);
}

function bumpStartupFailure(w, now, cfg) {
  const windowMs = cfg && Number(cfg.windowMs) > 0 ? Number(cfg.windowMs) : 60000;
  const burst = cfg && Number(cfg.burst) >= 1 ? Number(cfg.burst) : 5;
  let start = w.start;
  let count = w.count;
  if (start === null || start === undefined || now - start > windowMs) {
    start = now;
    count = 1;
  } else {
    count += 1;
  }
  return { start, count, tripped: count >= burst };
}

function makeBudget(cfg) {
  const windowMs = (cfg && Number(cfg.windowMs) > 0) ? Number(cfg.windowMs) : 60000;
  const burst = (cfg && Number(cfg.burst) >= 1) ? Number(cfg.burst) : 5;
  let state = { start: null, count: 0 };
  const self = {
    windowMs, burst,
    get count() { return state.count; },
    get tripped() { return state.count >= burst; },
    
    note(startupFailure) {
      if (startupFailure === false || startupFailure == null) {
        return { tripped: false, count: state.count, halted: false };
      }
      const dec = bumpStartupFailure(state, Date.now(), { windowMs, burst });
      state.start = dec.start; state.count = dec.count;
      return { tripped: dec.tripped, count: state.count, halted: dec.tripped };
    },
    reset() { state = { start: null, count: 0 }; },
  };
  return self;
}

module.exports = { shouldGuard, bumpStartupFailure, makeBudget };
