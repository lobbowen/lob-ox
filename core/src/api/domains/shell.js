'use strict';

const BRAND = require('../../shared/brand');

function owns(pathname) {
  return pathname === '/shell/status' || pathname.startsWith('/shell/');
}

function handle(ctx) {
  const { sup, req, res, pathname, send, collectBody, originAllowed } = ctx;
  const shell = sup.shellDomain;
  if (!shell) { return send(503, { ok: false, error: '壳安全网未初始化' }); }

  if (req.method === 'GET' && pathname === '/shell/status') {
    try { return send(200, Object.assign({ ok: true }, shell.status())); }
    catch (e) { return send(500, { ok: false, error: e.message }); }
  }

  if (req.method === 'POST' && pathname === '/shell/health') {
    if (!originAllowed(req)) { req.resume(); return send(403, {}); }
    return collectBody(req, res, 8192, (body) => {
      let j = {};
      try { j = body ? JSON.parse(body) : {}; } catch {}
      try { return send(200, shell.health(j)); }
      catch (e) { return send(500, { ok: false, error: e.message }); }
    });
  }

  if (req.method === 'POST' && pathname === '/shell/check-update') {
    if (!originAllowed(req)) { req.resume(); return send(403, {}); }
    req.resume();
    return Promise.resolve(shell.checkUpdate(sup.dist, { authoritative: true }))
      .then((r) => {
        if (sup.events) {
          sup.events.append(BRAND.EVENT_SHELL_UPDATE_CHECKED, { installed: r.installed, latest: r.latest, updateAvailable: r.updateAvailable });
        }
        return send(200, r);
      })
      .catch((e) => send(500, { ok: false, error: e.message }));
  }

  if (req.method === 'GET' || req.method === 'POST') return send(404, { error: 'not found', path: pathname });
  return send(405, { error: 'method not allowed' });
}

module.exports = { owns, handle };
