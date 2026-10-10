'use strict';

const { isInternalEvent } = require('../../platform/service/log/hub');

function owns(pathname) {
  return pathname === '/status' || pathname.startsWith('/lifecycle') || pathname === '/healthz' || pathname === '/readyz' || pathname === '/events' || pathname.startsWith('/logs') || pathname === '/metrics' || pathname === '/session/stop' || pathname === '/session/status';
}

function handle(ctx) {
  const { sup, req, pathname, send, originAllowed } = ctx;

    if (req.method === 'GET' && pathname === '/status') {
      return send(200, sup.statusSummary());
    }

    if (req.method === 'GET' && pathname === '/session/status') {
      return send(200, { sessionState: sup.sessionState ? sup.sessionState() : 'unknown' });
    }
    if (req.method === 'POST' && pathname === '/session/stop') {
      if (!originAllowed(req)) { req.resume(); return send(403, { ok: false, error: 'cross-origin request rejected' }); }
      req.resume();
      return Promise.resolve(sup.shutdownAll())
        .then((r) => send(r && r.ok === false ? 400 : 200, r || { ok: true }))
        .catch((e) => send(500, { ok: false, error: e.message }));
    }

    if (pathname === '/lifecycle' || pathname === '/lifecycle/status') {
      const lm = sup.lifecycleManager;
      return send(200, lm ? { modules: lm.statusAll() } : { modules: [] });
    }
    if (pathname.startsWith('/lifecycle/')) {
      const lm = sup.lifecycleManager;
      if (!lm) return send(503, { error: 'lifecycleManager 未初始化' });
      const rest = pathname.slice('/lifecycle/'.length);
      const parts = rest.split('/');
      const id = parts[0];
      const action = parts[1] || null;
      if (req.method === 'GET' && !action) {
        const lc = lm.get(id);
        return lc ? send(200, lc.snapshot()) : send(404, { error: '模块未注册: ' + id });
      }
      if (req.method === 'POST' && action) {
        if (!originAllowed(req)) { req.resume(); return send(403, { ok: false, error: 'cross-origin request rejected' }); }
        const lc = lm.get(id);
        if (!lc) return send(404, { error: '模块未注册: ' + id });
        if (id === 'dsh' && sup && (action === 'start' || action === 'stop' || action === 'restart')) {
          const act = action === 'start' ? lm.start(id)
            : action === 'stop' ? lm.stop(id, 'user')
            : lm.restart(id);
          return act.then((r) => {
            if (r && r.error) return send(409, { ok: false, error: r.error });
            const snap = sup.statusSummary ? sup.statusSummary() : {};
            return send(200, { ok: r.ok !== false, desired: snap.desired || sup.desired, phase: snap.phase || sup.phase });
          }).catch((e) => send(500, { error: e.message }));
        }
        if (action === 'start') { lm.start(id).then((r) => send(r.ok === false ? 409 : 200, r)).catch((e) => send(500, { error: e.message })); return; }
        if (action === 'stop') { lm.stop(id, 'user').then((r) => send(r.ok === false ? 409 : 200, r)).catch((e) => send(500, { error: e.message })); return; }
        if (action === 'restart') { lm.restart(id).then((r) => send(r && r.ok === false ? 409 : 200, r)).catch((e) => send(500, { error: e.message })); return; }
        return send(400, { error: '未知动作: ' + action + '（start|stop|restart）' });
      }
      return send(400, { error: '非法请求' });
    }

    if (req.method === 'GET' && pathname === '/healthz') {
      return send(200, sup.health ? sup.health.live() : { ok: true, pid: process.pid });
    }
    if (req.method === 'GET' && pathname === '/readyz') {
      return send(200, sup.health ? sup.health.ready() : { ok: true, ready: true });
    }

    if (req.method === 'GET' && pathname === '/events') {
      let after = 0;
      let limit = 50;
      let filter = null;
      let showInternal = false;
      try {
        const u = new URL(req.url, 'http://localhost');
        after = Math.max(Number(u.searchParams.get('after') || 0) || 0, 0);
        limit = Math.min(Math.max(Number(u.searchParams.get('limit') || 50) || 50, 1), 500);
        showInternal = u.searchParams.get('internal') === '1' || u.searchParams.get('internal') === 'true';
        const src = u.searchParams.get('source');
        const typ = u.searchParams.get('type');
        if (src || typ) filter = { source: src || undefined, type: typ || undefined };
      } catch {}
      const hub = sup.eventHub;
      if (!hub) return send(200, { seq: (sup.events && sup.events.seq) || 0, events: [] });
      const seq = hub.seq;
      let list = [];
      if (showInternal) {
        list = filter ? hub.readFiltered(filter, after, limit) : hub.read(after, limit);
      } else if (filter) {
        list = hub.readFiltered(filter, after, limit).filter((e) => (e.internal === undefined ? !isInternalEvent(e && e.type) : !e.internal));
      } else {
        list = hub.readVisible(after, limit);
      }
      return send(200, { seq, events: list });
    }

    if (req.method === 'GET' && pathname === '/logs/tail') {
      const u = new URL(req.url, 'http://localhost');
      const stream = u.searchParams.get('stream') || 'guard';
      const n = Math.min(Math.max(Number(u.searchParams.get('n') || 100) || 100, 1), 2000);
      return send(200, { stream, lines: sup.eventHub ? sup.eventHub.tailLog(stream, n) : [] });
    }
    if (req.method === 'GET' && pathname === '/logs/export') {
      const u = new URL(req.url, 'http://localhost');
      const after = Math.max(Number(u.searchParams.get('after') || 0) || 0, 0);
      const limit = Math.min(Math.max(Number(u.searchParams.get('limit') || 2000) || 2000, 1), 20000);
      const lines = sup.eventHub.exportLines(after, limit);
      return send(200, { seq: sup.eventHub.seq, exported: lines.length, lines });
    }

    if (req.method === 'GET' && pathname === '/metrics') {
      if (!sup.eventHub) return send(200, { gseq: 0, events: 0, bySource: {}, topTypes: [], sinceLastMs: null, ts: new Date().toISOString() });
      return send(200, sup.eventHub.metrics());
    }

  if (req.method === 'GET' || req.method === 'POST') return send(404, { error: 'not found', path: pathname });
  return send(405, { error: 'method not allowed' });
}

module.exports = { owns, handle };
