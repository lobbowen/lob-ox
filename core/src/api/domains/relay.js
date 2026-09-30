'use strict';

// 域：远程控制 API。/lan-access 为只读脱敏列表（见 app/facade/lan.js）；/remote/* 为唯一意图面：
// set-mode 是远程控制唯一写入口（缺令牌即在此分配）、set-token 是访问令牌显式改写的唯一入口，
// 另有 frp 状态/配置/安装。写动作全部经 supervisor 门面（app/domain-actions/lan.js），本层不做域判断。
function owns(pathname) {
  return pathname === '/lan-access' || pathname === '/remote/frp' || pathname.startsWith('/remote/');
}

function handle(ctx) {
  const { sup, req, res, pathname, send, collectBody, originAllowed } = ctx;

    if (req.method === 'GET' && pathname === '/remote/frp') {
      return Promise.resolve(sup.frpStatus()).then((r) => send(200, r)).catch((e) => send(500, { ok: false, error: e.message }));
    }
    if (req.method === 'GET' && pathname === '/lan-access') {
      return Promise.resolve(sup.listLan()).then((r) => send(200, r)).catch((e) => send(500, { ok: false, error: e.message }));
    }
    if (req.method === 'POST' && pathname.startsWith('/remote/')) {
      if (!originAllowed(req, sup.config.apiPort)) { req.resume(); return send(403, {}); }
      const act = pathname.slice('/remote/'.length);
      collectBody(req, res, 65536, (body) => {
        let j = {};
        try { j = body ? JSON.parse(body) : {}; } catch {}
        // {ok:false} 一律映射非 2xx：恒 200 会让面板显示「已开启」而实际未开。
        const reply = (r) => send(r && r.ok !== false ? 200 : 400, r);
        try {
          if (act === 'set-mode') {
            if (!j.id) return send(400, { ok: false, error: 'need id' });
            return Promise.resolve(sup.setRemoteMode(j.id, j.mode)).then(reply).catch((e) => send(500, { ok: false, error: e.message }));
          }
          if (act === 'set-token') {
            if (!j.id) return send(400, { ok: false, error: 'need id' });
            return Promise.resolve(sup.setRemoteToken(j.id, j.token)).then(reply).catch((e) => send(500, { ok: false, error: e.message }));
          }
          if (act === 'frp-server') {
            return Promise.resolve(sup.lanFrpc('settings', j)).then((r) => send(r && r.ok !== false ? 200 : 400, r)).catch((e) => send(500, { ok: false, error: e.message }));
          }
          if (act === 'frp-install') {
            return Promise.resolve(sup.lanFrpc('install', {})).then((r) => send(r && r.ok !== false ? 200 : (r && r.needInstall ? 400 : 500), r)).catch((e) => send(500, { ok: false, error: e.message }));
          }
        } catch (e) { return send(500, { ok: false, error: (e && e.message) || String(e) }); }
        return send(404, { error: 'not found' });
      });
      return;
    }
  // 域内未匹配(方法/子路径)：全局兜底语义
  if (req.method === 'GET' || req.method === 'POST') return send(404, { error: 'not found', path: pathname });
  return send(405, { error: 'method not allowed' });
}

module.exports = { owns, handle };
