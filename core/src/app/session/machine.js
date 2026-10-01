'use strict';

function createSession(deps) {
  const g = deps || {};
  const ev = () => (typeof g.events === 'function' ? g.events() : null);
  let state = 'starting';

  function setState(s) {
    if (state === s) return;
    const prev = state;
    state = s;
    const events = ev();
    if (events) { try { events.append('session_state', { from: prev, to: s }); } catch {} }
  }

  function halting() { return state === 'stopping' || state === 'stopped'; }

  function shouldRun() {
    if (g.desired() !== 'running') return false;
    if (halting()) return false;
    if (typeof g.crashHalted === 'function' && g.crashHalted()) return false;
    return true;
  }

  return { state: () => state, setState, halting, shouldRun };
}

module.exports = { createSession };
