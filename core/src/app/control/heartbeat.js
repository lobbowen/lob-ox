'use strict';

const ADAPTER_TIMEOUT_TICKS = 6;

function withTimeout(registry, p, ms, id) {
  let t = null;
  const timeout = new Promise((resolve) => {
    t = setTimeout(() => resolve({ __timedOut: true, ok: false, error: '监督超时(' + ms + 'ms)' }), ms);
    if (t && typeof t.unref === 'function') t.unref();
  });
  return Promise.race([Promise.resolve(p).finally(() => { if (t) clearTimeout(t); }), timeout])
    .catch((e) => ({ ok: false, error: (e && e.message) || String(e) }))
    .then((res) => {
      if (res && res.__timedOut) {
        registry._log('warn', 'heartbeat 监督超时(' + id + ')：已跳过本拍（防心跳停摆）');
      }
      return res;
    });
}

async function runHeartbeat(registry, intervalMs) {
  if (registry._heartbeatInFlight) return registry._heartbeatInFlight;
  const beat = runBeat(registry, intervalMs);
  registry._heartbeatInFlight = beat;
  try {
    return await beat;
  } finally {
    if (registry._heartbeatInFlight === beat) registry._heartbeatInFlight = null;
  }
}

async function runBeat(registry, intervalMs) {
  const iv = intervalMs || 5000;
  const now = Date.now();
  const observed = [];
  const errors = [];
  for (const e of registry._objects.slice()) {
    const ad = registry._adapters[e.kind];
    if (!ad) continue;
    const fn = (typeof ad.supervise === 'function') ? ad.supervise : ((typeof ad.observe === 'function') ? ad.observe : null);
    if (!fn) continue;
    const tickEvery = ad.tickEvery || (e.ownership && e.ownership.meta && e.ownership.meta.tickEvery) || 1;
    if (tickEvery > 1) {
      if (e._nextTickAt && now < e._nextTickAt) continue;
      e._nextTickAt = Date.now() + tickEvery * iv;
    }
    try {
      const res = await withTimeout(registry, fn(e), iv * ADAPTER_TIMEOUT_TICKS, e.id);
      if (res && res.__timedOut) errors.push(e.id + ':' + (res.error || '监督超时'));
      if (res && typeof res.ok === 'boolean') {
        if (registry.get(e.id) !== e) continue;
        registry.applyObservation(e.id, res);
        if (ad.derivePhase === true) {
          const want = e.desired === 'running';
          const p = (want && res.ok) ? 'running' : 'stopped';
          if (e.phase !== p) registry.setPhase(e.id, p);
        }
      }
      observed.push(e.id);
    } catch (err) {
      errors.push(e.id + ':' + ((err && err.message) || err));
      registry._log('warn', 'heartbeat ' + (ad.supervise ? 'supervise' : 'observe') + '(' + e.kind + ':' + e.id + '): ' + ((err && err.message) || err));
    }
  }
  if (typeof registry.onBeatDone === 'function') {
    try { await registry.onBeatDone({ observed, errors }); }
    catch (err) { registry._log('warn', 'heartbeat onBeatDone: ' + ((err && err.message) || err)); }
  }
  return { observed, errors };
}

module.exports = { runHeartbeat, withTimeout, ADAPTER_TIMEOUT_TICKS };
