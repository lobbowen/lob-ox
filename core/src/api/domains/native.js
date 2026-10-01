'use strict';

function owns(pathname) {
  return pathname.startsWith('/native/');
}

function handle(ctx) {
  const { sup, req, res, pathname, send, collectBody, originAllowed } = ctx;

    if (req.method === 'GET' && pathname === '/native/status') {
      return send(200, {
        ...(sup.nativeManager ? sup.nativeManager.status() : { installed: false }),
        versionInfo: sup.nativeManager ? sup.nativeManager.versionInfo() : null,
        upgrade: sup.nativeManager ? sup.nativeManager.upgradeStatus() : null,
      });
    }
    if (req.method === 'POST' && pathname === '/native/check-update') {
      if (!originAllowed(req, sup.config.apiPort)) { req.resume(); return send(403, { ok: false, error: 'cross-origin request rejected' }); }
      sup.nativeManager.checkUpdate().then((r) => send(200, { ok: true, ...r })).catch((e) => send(500, { ok: false, error: e.message }));
      return;
    }
    if (req.method === 'POST' && pathname === '/native/install') {
      if (!originAllowed(req, sup.config.apiPort)) { req.resume(); return send(403, { ok: false, error: 'cross-origin request rejected' }); }
      collectBody(req, res, 1024, (body) => {
        let version = null;
        try { const j = body ? JSON.parse(body) : {}; if (typeof j.version === 'string' && j.version) version = j.version; } catch {}
        const r = sup.nativeManager.startInstall(version);
        if (r && r.ok === false) return send(400, r);
        return send(202, { ok: true, accepted: true, state: 'installing' });
      });
      return;
    }
    if (req.method === 'POST' && pathname === '/native/upgrade') {
      if (!originAllowed(req, sup.config.apiPort)) { req.resume(); return send(403, { ok: false, error: 'cross-origin request rejected' }); }
      collectBody(req, res, 4096, (body) => {
        let requested = null;
        try { const j = body ? JSON.parse(body) : {}; if (j && typeof j.version === 'string' && j.version) requested = j.version; } catch {}
        if (sup.nativeManager.busy()) {
          return send(409, { error: 'upgrade already in progress', state: sup.nativeManager.upgradeState });
        }
        sup.nativeManager.upgrade(requested).catch(() => {});
        send(202, { ok: true, accepted: true });
      });
      return;
    }
    if (req.method === 'POST' && pathname === '/native/uninstall') {
      if (!originAllowed(req, sup.config.apiPort)) { req.resume(); return send(403, { ok: false, error: 'cross-origin request rejected' }); }
      const r = sup.nativeManager.startUninstall();
      if (r && r.ok === false) return send(400, r);
      return send(202, { ok: true, accepted: true, state: 'uninstalling' });
    }
    if (req.method === 'POST' && pathname === '/native/settings') {
      if (!originAllowed(req, sup.config.apiPort)) { req.resume(); return send(403, { ok: false, error: 'cross-origin request rejected' }); }
      collectBody(req, res, 4096, (body) => {
        try {
          const j = body ? JSON.parse(body) : {};
          if (sup.patchDshMain && typeof sup.patchDshMain === 'function') {
            const r = sup.patchDshMain(j);
            return send(r && r.ok === false ? 400 : 200, r);
          }
          return send(500, { ok: false, error: '守卫未实现 patchDshMain' });
        } catch (e) { return send(400, { ok: false, error: e.message }); }
      });
      return;
    }
  if (req.method === 'GET' || req.method === 'POST') return send(404, { error: 'not found', path: pathname });
  return send(405, { error: 'method not allowed' });
}

module.exports = { owns, handle };
