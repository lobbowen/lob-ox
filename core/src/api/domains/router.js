'use strict';

function owns(pathname) {
  return pathname.startsWith('/router/');
}

function handle(ctx) {
  const { sup, req, res, pathname, send, collectBody, originAllowed } = ctx;

    if (req.method === 'GET' && pathname === '/router/domain-summary') {
      return send(200, sup.routerDomainSummary());
    }
    if (req.method === 'GET' && pathname === '/router/ports') {
      return Promise.resolve(sup.routerApi().portsView()).then((r) => send(200, r)).catch((e) => send(500, { ok: false, records: [], error: (e && e.message) || String(e) }));
    }
    if (req.method === 'GET' && pathname === '/router/status') {
      return Promise.resolve(sup.routerStatusView()).then((r) => send(200, r)).catch((e) => send(500, { ok: false, running: false, error: (e && e.message) || String(e) }));
    }
    if (req.method === 'POST' && pathname.startsWith('/router/')) {
      if (!originAllowed(req, sup.config.apiPort)) {
        req.resume();
        return send(403, { ok: false, error: 'cross-origin request rejected' });
      }
      const action = pathname.slice('/router/'.length);
      req.resume();
      if (action === 'start') {
        return Promise.resolve(sup.setRouterRunning(true)).then((r) => send(r && r.ok === false ? 400 : 200, r)).catch((e) => send(500, { ok: false, error: (e && e.message) || String(e) }));
      }
      if (action === 'stop') {
        return Promise.resolve(sup.setRouterRunning(false)).then((r) => send(r && r.ok === false ? 400 : 200, r)).catch((e) => send(500, { ok: false, error: (e && e.message) || String(e) }));
      }
    }

    if (req.method === 'GET' && pathname === '/router/providers') {
      return Promise.resolve(sup.routerProviders()).then((r) => send(200, r)).catch((e) => send(500, { ok: false, error: e.message }));
    }
    if (req.method === 'POST' && pathname === '/router/providers/add') {
      if (!originAllowed(req, sup.config.apiPort)) { req.resume(); return send(403, {}); }
      collectBody(req, res, 65536, (body) => {
        let j = {};
        try { j = body ? JSON.parse(body) : {}; } catch {}
        if (j.kind === 'proxy') {
          Promise.resolve(sup.routerApi().addProxyProvider({ name: j.name, appId: j.appId, keys: j.keys || [] })).then((r) => send(r.ok ? 200 : 400, r)).catch((e) => send(500, { ok: false, error: (e && e.message) || String(e) }));
          return;
        }
        return Promise.resolve(sup.routerApi().addDirectProvider({ name: j.name, presetId: j.presetId, keys: j.keys || [] })).then((r) => send(r && r.ok === false ? 400 : 200, r)).catch((e) => send(500, { ok: false, error: e.message }));
      });
      return;
    }
    if (req.method === 'POST' && pathname === '/router/proxy/login/start') {
      if (!originAllowed(req, sup.config.apiPort)) { req.resume(); return send(403, {}); }
      Promise.resolve(sup.routerApi().commandcodeLoginStart()).then((r) => send(r.ok ? 200 : 400, r)).catch((e) => send(500, { ok: false, error: (e && e.message) || String(e) }));
      return;
    }
    if (req.method === 'POST' && pathname === '/router/proxy/login/wait') {
      if (!originAllowed(req, sup.config.apiPort)) { req.resume(); return send(403, {}); }
      collectBody(req, res, 4096, (body) => { const j = {}; try { j.t = body ? JSON.parse(body).timeoutMs : 180000; } catch {}; const t = Math.min(Math.max(Number(j.t) || 180000, 5000), 300000); Promise.resolve(sup.routerApi().commandcodeLoginWait(t)).then((r) => send(r.ok ? 200 : 400, r)).catch((e) => send(500, { ok: false, error: e.message })); });
      return;
    }

    if (req.method === 'POST' && pathname === '/router/proxy/update/check') {
      if (!originAllowed(req, sup.config.apiPort)) { req.resume(); return send(403, {}); }
      Promise.resolve(sup.routerApi().refreshProxyUpdateInfo(true)).then((r) => send(200, { ok: true, versions: r })).catch((e) => send(500, { ok: false, error: e.message }));
      return;
    }
    if (req.method === 'POST' && pathname === '/router/proxy/update/apply') {
      if (!originAllowed(req, sup.config.apiPort)) { req.resume(); return send(403, {}); }
      collectBody(req, res, 4096, (body) => { try { const j = body ? JSON.parse(body) : {}; Promise.resolve(sup.routerApi().applyProxyUpdate(j.appId, j)).then((r) => send(r.ok ? 200 : 400, r)).catch((e) => send(500, { ok: false, error: (e && e.message) || String(e) })); } catch { return send(400, { ok: false }); } });
      return;
    }
    if (req.method === 'GET' && pathname === '/router/proxy/update/status') {
      const u = new URL(req.url, 'http://localhost');
      return Promise.resolve(sup.routerApi().proxyUpdateStatus(u.searchParams.get('appId') || '')).then((r) => send(200, r)).catch((e) => send(500, { ok: false, error: e.message }));
    }
    if (req.method === 'POST' && pathname === '/router/providers/proxy/key') {
      if (!originAllowed(req, sup.config.apiPort)) { req.resume(); return send(403, {}); }
      collectBody(req, res, 65536, (body) => { try { const j = JSON.parse(body); Promise.resolve(sup.routerApi().addProxyKey(j.id, j.key)).then((r) => send(r.ok ? 200 : 400, r)).catch((e) => send(500, { ok: false, error: (e && e.message) || String(e) })); } catch { return send(400, { ok: false }); } });
      return;
    }
    if (req.method === 'POST' && pathname === '/router/providers/proxy/select') {
      if (!originAllowed(req, sup.config.apiPort)) { req.resume(); return send(403, {}); }
      collectBody(req, res, 4096, (body) => { try { const j = JSON.parse(body); Promise.resolve(sup.routerApi().setSelectedProxyKey(j.id, j.keyId)).then((r) => send(r.ok ? 200 : 400, r)).catch((e) => send(500, { ok: false, error: (e && e.message) || String(e) })); } catch { return send(400, { ok: false }); } });
      return;
    }
    if (req.method === 'POST' && pathname === '/router/providers/proxy/key/remove') {
      if (!originAllowed(req, sup.config.apiPort)) { req.resume(); return send(403, {}); }
      collectBody(req, res, 4096, (body) => { try { const j = JSON.parse(body); Promise.resolve(sup.routerApi().removeProxyKey(j.id, j.keyId)).then((r) => send(r.ok ? 200 : 400, r)).catch((e) => send(500, { ok: false, error: (e && e.message) || String(e) })); } catch { return send(400, { ok: false }); } });
      return;
    }
    if (req.method === 'POST' && pathname === '/router/providers/keys/set') {
      if (!originAllowed(req, sup.config.apiPort)) { req.resume(); return send(403, {}); }
      collectBody(req, res, 65536, (body) => {
        try {
          const j = JSON.parse(body);
          if (!j.id) return send(400, { ok: false, error: 'need id' });
          return Promise.resolve(sup.routerApi().setProviderKeys(j.id, { removeMasked: j.removeMasked || [], add: j.add || [] })).then((r) => send(r && r.ok === false ? 400 : 200, r)).catch((e) => send(500, { ok: false, error: e.message }));
        } catch { return send(400, { ok: false }); }
      });
      return;
    }
    if (req.method === 'POST' && pathname === '/router/providers/remove') {
      if (!originAllowed(req, sup.config.apiPort)) { req.resume(); return send(403, {}); }
      collectBody(req, res, 4096, (body) => {
        try {
          const j = body ? JSON.parse(body) : {};
          return Promise.resolve(sup.routerApi().removeProvider(j.id)).then((r) => send(r && r.ok === false ? 400 : 200, r)).catch((e) => send(500, { ok: false, error: e.message }));
        } catch { return send(400, { ok: false }); }
      });
      return;
    }
    if (req.method === 'POST' && pathname === '/router/providers/key/use') {
      if (!originAllowed(req, sup.config.apiPort)) { req.resume(); return send(403, {}); }
      collectBody(req, res, 4096, (body) => {
        try {
          const j = body ? JSON.parse(body) : {};
          if (!j.id || !j.fingerprint) return send(400, { ok: false, error: 'need id + fingerprint' });
          return Promise.resolve(sup.routerApi().switchToKey(j.id, j.fingerprint)).then((r) => send(r && r.ok ? 200 : 400, r || { ok: false, error: 'unknown' })).catch((e) => send(500, { ok: false, error: e.message }));
        } catch { return send(400, { ok: false }); }
      });
      return;
    }

    if (req.method === 'POST' && pathname === '/router/providers/account/discard') {
      if (!originAllowed(req, sup.config.apiPort)) { req.resume(); return send(403, {}); }
      collectBody(req, res, 4096, (body) => { try { const j = JSON.parse(body); Promise.resolve(sup.routerApi().discardAccount(j.id, j.keyId)).then((r) => send(r.ok ? 200 : 400, r)).catch((e) => send(500, { ok: false, error: (e && e.message) || String(e) })); } catch { return send(400, { ok: false }); } });
      return;
    }
    if (req.method === 'POST' && pathname === '/router/providers/refresh') {
      if (!originAllowed(req, sup.config.apiPort)) { req.resume(); return send(403, {}); }
      collectBody(req, res, 4096, (body) => { try { const j = body ? JSON.parse(body) : {}; if (!j.id) return send(400, { ok: false }); Promise.resolve(sup.routerApi().refreshProviderQuota(j.id)).then((r) => send(r.ok ? 200 : 400, r)).catch((e) => send(500, { ok: false, error: (e && e.message) || String(e) })); } catch { return send(400, { ok: false }); } });
      return;
    }
    if (req.method === 'POST' && pathname === '/router/providers/activate') {
      if (!originAllowed(req, sup.config.apiPort)) { req.resume(); return send(403, {}); }
      collectBody(req, res, 4096, (body) => { try { const j = body ? JSON.parse(body) : {}; if (!j.id) return send(400, { ok: false, error: 'need id' }); Promise.resolve(sup.routerApi().activateProvider(j.id)).then((r) => send(r && r.ok ? 200 : 400, r || { ok: false })).catch(() => send(400, { ok: false })); } catch { return send(400, { ok: false }); } });
      return;
    }
    if (req.method === 'POST' && pathname === '/router/providers/deactivate') {
      if (!originAllowed(req, sup.config.apiPort)) { req.resume(); return send(403, {}); }
      collectBody(req, res, 4096, (body) => { try { const j = body ? JSON.parse(body) : {}; if (!j.id) return send(400, { ok: false, error: 'need id' }); return Promise.resolve(sup.routerApi().deactivateProvider(j.id)).then((r) => send(r && r.ok === false ? 400 : 200, r)).catch((e) => send(500, { ok: false, error: e.message })); } catch { return send(400, { ok: false }); } });
      return;
    }
  if (req.method === 'GET' || req.method === 'POST') return send(404, { error: 'not found', path: pathname });
  return send(405, { error: 'method not allowed' });
}

module.exports = { owns, handle };
