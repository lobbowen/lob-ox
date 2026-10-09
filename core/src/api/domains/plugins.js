'use strict';

function owns(pathname) {
  return pathname.startsWith('/plugins/');
}

function handle(ctx) {
  const { sup, req, res, pathname, send, collectBody, originAllowed } = ctx;

    if (req.method === 'GET' && pathname === '/plugins/market') {
      const force = req.url.indexOf('refresh=1') >= 0;
      return sup.pluginMarket.getIndex(force).then(
        (r) => send(200, r),
        (e) => send(500, { ok: false, error: e.message })
      );
    }
    if (req.method === 'GET' && pathname === '/plugins/installed') {
      return sup.pluginManager.listInstalled().then((r) => send(200, r)).catch((e) => send(500, { ok: false, error: e.message }));
    }
    if (req.method === 'GET' && pathname === '/plugins/check-updates') {
      const force = req.url.indexOf('refresh=1') >= 0;
      return sup.pluginManager.checkUpdates(force).then((r) => send(200, r)).catch((e) => send(500, { ok: false, error: e.message }));
    }
    if (req.method === 'GET' && pathname === '/plugins/install-status') {
      const u = new URL(req.url, 'http://localhost');
      return send(200, sup.pluginManager.installStatus(u.searchParams.get('job')));
    }
    if (req.method === 'POST' && pathname.startsWith('/plugins/')) {
      if (!originAllowed(req)) {
        req.resume();
        return send(403, { ok: false, error: 'cross-origin request rejected' });
      }
      const action = pathname.slice('/plugins/'.length);
      collectBody(req, res, 65536, (body) => {
        let name = null;
        let spec = null;
        let enabled = null;
        let target = null;
        try {
          const j = body ? JSON.parse(body) : {};
          if (typeof j.name === 'string') name = j.name;
          if (typeof j.spec === 'string') spec = j.spec;
          if (typeof j.enabled === 'boolean') enabled = j.enabled;
          if (typeof j.target === 'string') target = j.target;
        } catch {}
        if (action === 'disable' && name) return sup.pluginManager.setBundleEnabled(name, false, target).then((r) => send(r.ok ? 200 : 400, r));
        if (action === 'enable' && name) return sup.pluginManager.setBundleEnabled(name, true, target).then((r) => send(r.ok ? 200 : 400, r));
        if (action === 'uninstall' && name) return sup.pluginManager.uninstall(name, target).then((r) => send(r.ok ? 200 : 400, r));
        if (action === 'install' && spec) return sup.pluginManager.install(spec, { target }).then((r) => send(r.ok ? 200 : 400, r));
        if (action === 'update' && name) return sup.pluginManager.update(name, target).then((r) => send(r.ok ? 200 : 400, r));
        return send(404, { error: 'not found' });
      });
      return;
    }
  if (req.method === 'GET' || req.method === 'POST') return send(404, { error: 'not found', path: pathname });
  return send(405, { error: 'method not allowed' });
}

module.exports = { owns, handle };
