'use strict';

const fs = require('node:fs');
const path = require('node:path');

function owns(pathname) {
  return pathname === '/changelog' || pathname.startsWith('/guard/') || pathname === '/autostart'
    || pathname.startsWith('/settings/') || pathname.startsWith('/self-update/')
    || pathname === '/env/dsh' || pathname === '/env/status' || pathname === '/env/node-lts'
    || pathname === '/env/open-url' || pathname === '/env/environment'
    || pathname === '/env/environment/last'
    || pathname === '/ports' || pathname === '/shutdown';
}

function fetchDshChangelog(res, sup) {
  const v = (sup && sup.nativeManager) ? sup.nativeManager.versionInfo() : {};
  const inst = v.installed || '未安装';
  const latest = v.latest || '—';
  const upd = v.updateAvailable;
  const md = 'DeepSeek Harness（DSH）更新日志\n\n'
    + '当前安装：' + inst + '\n'
    + '最新版本：' + latest + '\n'
    + (upd ? ('检测到新版本，可在「概览 · 版本与升级」一键升级到 ' + latest + '。\n') : '当前已是最新版本。\n')
    + '\n完整变更记录见 DeepSeek Harness GitHub Releases：\n'
    + 'https://github.com/deepseek-ai/DeepSeek-Harness/releases\n';
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  return res.end(md);
}

function handle(ctx) {
  const { sup, req, res, pathname, identity, send, collectBody, originAllowed, browser, environment } = ctx;
    if (req.method === 'GET' && pathname === '/changelog') {
      return fetchDshChangelog(res, sup);
    }
    if (req.method === 'GET' && pathname === '/guard/changelog') {
      try {
        const md = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'CHANGELOG.md'), 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end(md);
      } catch {
        return send(404, { error: 'changelog not found' });
      }
    }
    if (req.method === 'GET' && pathname === '/guard/version') {
      return Promise.resolve(sup.guardVersionLocal()).then((r) => send(200, r)).catch((e) => send(500, { ok: false, error: e.message }));
    }
    if (req.method === 'POST' && pathname === '/guard/version/check') {
      req.resume();
      if (!originAllowed(req, sup.config.apiPort)) return send(403, { ok: false, error: 'cross-origin request rejected' });
      return sup.guardVersionCheck().then((r) => send(200, r)).catch((e) => send(500, { ok: false, error: e.message }));
    }

    if (req.method === 'GET' && pathname === '/autostart') {
      return send(200, sup.autostartStatus());
    }
    if (req.method === 'POST' && pathname === '/autostart') {
      if (!originAllowed(req, sup.config.apiPort)) {
        req.resume();
        return send(403, { ok: false, error: 'cross-origin request rejected' });
      }
      collectBody(req, res, 1024, (body) => {
        let enabled = null;
        try {
          const j = body ? JSON.parse(body) : {};
          if (typeof j.enabled === 'boolean') enabled = j.enabled;
        } catch {}
        if (enabled === null) return send(400, { ok: false, error: '需要 {"enabled":true|false}' });
        const r = sup.setAutostart(enabled);
        return send(r.ok ? 200 : 500, r);
      });
      return;
    }

    if (req.method === 'GET' && pathname === '/settings/lan') {
      return send(200, sup.lanPanelStatus());
    }
    if (req.method === 'POST' && pathname === '/settings/lan') {
      if (!originAllowed(req, sup.config.apiPort)) {
        req.resume();
        return send(403, { ok: false, error: 'cross-origin request rejected' });
      }
      collectBody(req, res, 1024, (body) => {
        let enabled = null;
        try { const j = body ? JSON.parse(body) : {}; if (typeof j.enabled === 'boolean') enabled = j.enabled; } catch {}
        if (enabled === null) return send(400, { ok: false, error: '需要 {"enabled":true|false}' });
        const r = sup.setLanPanel(enabled);
        return send(r.ok === false ? (r.code === 'ACCESS_KEY_REQUIRED' ? 400 : 500) : 200, r);
      });
      return;
    }
    if (req.method === 'GET' && pathname === '/settings/access-key') {
      return send(200, sup.accessKeyStatus());
    }
    if (req.method === 'POST' && pathname === '/settings/access-key') {
      if (!originAllowed(req, sup.config.apiPort)) {
        req.resume();
        return send(403, { ok: false, error: 'cross-origin request rejected' });
      }
      collectBody(req, res, 4096, (body) => {
        let key = null;
        try { const j = body ? JSON.parse(body) : {}; if (typeof j.key === 'string') key = j.key; } catch {}
        if (key === null) return send(400, { ok: false, error: '需要 {"key":"<访问密钥>"}（空串清除）' });
        if (key && key.length < 8) return send(400, { ok: false, error: '访问密钥至少 8 位（建议 16+ 位随机串）' });
        const r = sup.setAccessKey(key);
        return send(r.ok ? 200 : 500, r);
      });
      return;
    }
    if (req.method === 'GET' && pathname === '/settings/close-action') {
      return send(200, sup.closeActionStatus());
    }
    if (req.method === 'POST' && pathname === '/settings/close-action') {
      if (!originAllowed(req, sup.config.apiPort)) { req.resume(); return send(403, {}); }
      collectBody(req, res, 1024, (body) => {
        let v = null;
        try { const j = body ? JSON.parse(body) : {}; if (typeof j.closeAction === 'string') v = j.closeAction; } catch {}
        if (v === null) return send(400, { ok: false, error: '需要 {"closeAction":"hide"|"exit"}' });
        const r = sup.setCloseAction(v);
        return send(r.ok ? 200 : 500, r);
      });
      return;
    }
    if (req.method === 'GET' && pathname === '/settings/external-browser') {
      return send(200, sup.externalBrowserStatus());
    }
    if (req.method === 'POST' && pathname === '/settings/external-browser') {
      if (!originAllowed(req, sup.config.apiPort)) { req.resume(); return send(403, {}); }
      collectBody(req, res, 2048, (body) => {
        let id = null; let given = false;
        try { const j = body ? JSON.parse(body) : {}; if (typeof j.id === 'string') { id = j.id; given = true; } } catch {}
        if (!given) return send(400, { ok: false, error: '需要 {"id":"<候选 id>"}（空串清除偏好）' });
        const r = sup.setExternalBrowser(id);
        return send(r.ok ? 200 : 500, r);
      });
      return;
    }
    if (req.method === 'POST' && pathname === '/shutdown') {
      if (!originAllowed(req, sup.config.apiPort)) { req.resume(); return send(403, {}); }
      req.resume();
      Promise.resolve(sup.shutdownAll()).then((r) => { try { send(r.ok === false ? 400 : 200, r || { ok: true }); } catch {} }).catch(() => {});
      return;
    }

    if (req.method === 'GET' && pathname === '/self-update/status') {
      if (!originAllowed(req, sup.config.apiPort)) { req.resume(); return send(403, {}); }
      Promise.resolve(sup.guardSelfUpdateStatus()).then((r) => send(r.ok ? 200 : 400, r));
      return;
    }
    if (req.method === 'POST' && pathname === '/self-update/apply') {
      req.resume();
      return send(410, {
        ok: false,
        code: 'KERNEL_UPDATE_SINGLE_WRITER',
        owner: 'desktop-shell',
        error: '内核更新由桌面壳执行（单写入者契约）：请在桌面壳的面板中点「更新」，或升级/重装桌面壳。',
      });
    }
    if (req.method === 'POST' && pathname === '/self-update/restart-guard') {
      req.resume();
      return send(410, {
        ok: false,
        code: 'KERNEL_UPDATE_SINGLE_WRITER',
        owner: 'desktop-shell',
        error: '守卫重启由桌面壳经服务管理器执行（守卫从不重启自己）：更新内核请用桌面壳。',
      });
    }

    if (req.method === 'GET' && pathname === '/env/dsh') {
      if (!originAllowed(req, sup.config.apiPort)) { req.resume(); return send(403, {}); }
      return send(200, sup.dshenvStatus());
    }
    if (req.method === 'GET' && pathname === '/env/status') {
      if (!originAllowed(req, sup.config.apiPort)) { req.resume(); return send(403, {}); }
      return Promise.resolve(sup.envStatus()).then((r) => send(200, r)).catch((e) => send(500, { ok: false, error: e.message }));
    }
    if (req.method === 'GET' && pathname === '/env/node-lts') {
      return sup.nodeLtsStatus().then((r) => send(200, r)).catch((e) => send(500, { ok: false, error: e.message }));
    }
    if (req.method === 'GET' && pathname === '/env/environment') {
      if (!originAllowed(req, sup.config.apiPort)) { req.resume(); return send(403, { ok: false, error: 'cross-origin request rejected' }); }
      const force = /[?&]force=1/.test(String(req.url || ''));
      return Promise.resolve(force ? environment.refresh({ persist: true, force: true }) : environment.form())
        .then((r) => send(200, r))
        .catch((e) => send(500, { ok: false, error: '环境表单装配失败：' + ((e && e.message) || e) }));
    }
    if (req.method === 'GET' && pathname === '/env/environment/last') {
      if (!originAllowed(req, sup.config.apiPort)) { req.resume(); return send(403, { ok: false, error: 'cross-origin request rejected' }); }
      return send(200, environment.lastSnapshot());
    }
    if (req.method === 'POST' && pathname === '/env/open-url') {
      if (!identity.loopback) { req.resume(); return send(403, { ok: false, error: '仅内核所在机器可请内核调起浏览器，请复制或自行打开该地址' }); }
      if (!originAllowed(req, sup.config.apiPort)) { req.resume(); return send(403, { ok: false, error: 'cross-origin request rejected' }); }
      collectBody(req, res, 4096, (body) => {
        let url = null;
        try { const j = body ? JSON.parse(body) : {}; if (typeof j.url === 'string') url = j.url; } catch {}
        if (!url) return send(400, { ok: false, error: '需要 {"url":"http(s)://…"}' });
        return Promise.resolve(browser.openBrowser(url, { logger: sup.logger }))
          .then((r) => send(r.ok ? 200 : 500, r))
          .catch((e) => send(500, { ok: false, reason: 'spawn-failed', error: '打开浏览器失败：' + ((e && e.message) || e), url }));
      });
      return;
    }

    if (req.method === 'GET' && pathname === '/ports') {
      return Promise.resolve(sup.listPorts()).then((r) => send(200, r)).catch((e) => send(500, { error: e && e.message }));
    }
  if (req.method === 'GET' || req.method === 'POST') return send(404, { error: 'not found', path: pathname });
  return send(405, { error: 'method not allowed' });
}

module.exports = { owns, handle };
