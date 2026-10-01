'use strict';

// forwardOnce 在 response 时即清 connectGuard(15s)/responseGuard(180s)，此后读上游体无时限——发完头即挂起会永久悬挂。

const NONSTREAM_BODY_MAX_MS = 300000;

function readUpstreamBody(ur, maxBytes, timeoutMs) {
  return new Promise((resolve) => {
    const chunks = [];
    let n = 0;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString('utf8'));
    };
    const timer = setTimeout(() => { try { ur.destroy(); } catch {} finish(); }, timeoutMs || 15000);
    if (timer.unref) timer.unref();
    const cap = maxBytes || 65536;
    ur.on('data', (c) => { if (n < cap) { chunks.push(c); n += c.length; } });
    ur.on('end', finish);
    ur.on('error', finish);
    ur.on('close', finish);
  });
}

function trackUpstreamBody(ur, opts) {
  const o = opts || {};
  const res = o.res;
  const onData = o.onData || (() => {});
  let timer = null, done = false;
  const cancel = () => { if (timer) { clearTimeout(timer); timer = null; } };
  const finish = (fn) => { if (done) return; done = true; cancel(); if (fn) fn(); };
  if (!o.streamRequested) {
    timer = setTimeout(() => { try { ur.destroy(); } catch {} finish(o.onAbort); }, o.timeoutMs || NONSTREAM_BODY_MAX_MS);
    if (timer.unref) timer.unref();
  }
  ur.on('data', (c) => { if (onData(c) === false) ur.pause(); });
  if (res && typeof res.on === 'function') res.on('drain', () => ur.resume());
  ur.on('end', () => finish(o.onEnd));
  ur.on('aborted', () => finish(o.onAbort));
  ur.on('error', () => finish(o.onAbort));
  ur.on('close', () => { if (!ur.readableEnded) finish(o.onAbort); });
  return { cancel };
}

module.exports = { readUpstreamBody, trackUpstreamBody };
