'use strict';

const execPath = require('../../platform/os/exec-path');

const crypto = require('node:crypto');
const { bootstrapDshCookie } = require('../../platform/service/token/exchange');
const { liveApiPort } = require('../security');

const OPEN_WEB_CODES = new Map();
const OPEN_WEB_CODE_TTL_MS = 30000;

function _sweepExpiredOpenWebCodes() {
  const now = Date.now();
  for (const [code, rec] of OPEN_WEB_CODES) {
    if (!(rec && rec.exp > now)) OPEN_WEB_CODES.delete(code);
  }
}

function issueOpenWebCode(id) {
  _sweepExpiredOpenWebCodes();
  const code = crypto.randomUUID();
  OPEN_WEB_CODES.set(code, { id, exp: Date.now() + OPEN_WEB_CODE_TTL_MS });
  return code;
}

function consumeOpenWebCode(code) {
  if (!code) return null;
  const rec = OPEN_WEB_CODES.get(code);
  if (!rec) return null;
  OPEN_WEB_CODES.delete(code);
  if (!(rec.exp > Date.now())) return null;
  return { id: rec.id };
}

function dropOpenWebCode(code) { if (code) OPEN_WEB_CODES.delete(code); }

function owns(pathname) {
  return pathname === '/open' || pathname === '/instances' || pathname.startsWith('/instances/');
}

function findInstanceOrMain(sup, id) {
  if (id === 'main' && sup.dshMainView && typeof sup.dshMainView === 'function') return sup.dshMainView();
  return (sup.instances.list() || []).find((x) => x.id === id) || null;
}

function handleOpen(ctx) {
  const { sup, req, res, identity, originAllowed, tokOf, server } = ctx;
  const url = new URL(req.url, 'http://localhost');
  const apiPort = liveApiPort(server, sup);
  const code = url.searchParams.get('code');
  const deny = (status, msg) => { res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end(msg); };
  if (!identity.loopback) return deny(403, '仅允许本机访问');
  if (!originAllowed(req)) return deny(403, 'origin not allowed');
  const rec = consumeOpenWebCode(code);
  if (!rec) return deny(code ? 400 : 404, code ? '授权码无效或已过期' : '缺少授权码');
  const it = findInstanceOrMain(sup, rec.id);
  if (!it) return deny(404, '实例不存在');
  const tok = tokOf(rec.id);
  if (!tok) return deny(400, '实例令牌不可用');
  return bootstrapDshCookie('127.0.0.1', it.port, tok).then((cookie) => {
    if (!cookie) return deny(400, '令牌换取失败');
    res.writeHead(303, {
      'Set-Cookie': cookie + '; Path=/; HttpOnly; SameSite=Strict',
      'Location': 'http://127.0.0.1:' + it.port + '/',
    });
    res.end();
  }).catch((e) => { dropOpenWebCode(code); deny(500, (e && e.message) || 'open failed'); });
}

function commandShapeError(command, dshBin) {
  if (command === undefined || command === null) return null;
  if (!Array.isArray(command)) return 'command 必须为参数数组';
  if (!command.length) return null;
  if (command.length > 64) return 'command 参数过多（上限 64）';
  for (const a of command) {
    if (typeof a !== 'string') return 'command 每项必须为字符串';
    if (!a.length) return 'command 不允许空参数';
    if (a.length > 4096) return 'command 单个参数过长（上限 4096）';
    if (/[\0\r\n]/.test(a)) return 'command 含非法字符（NUL/换行）';
  }
  const NODE_HEAD = new Set(['node', 'node.exe']);
  const DSH_HEAD = new Set(['dsh', 'dsh.exe', 'dsh.js', 'lobox', 'lobox.js', 'dsh.cmd', 'dsh.ps1']);
  const DSH_ENTRY = new Set(['dsh', 'dsh.js', 'lobox', 'lobox.js']);
  const baseOf = (p) => String(p).split(/[\\/]/).pop().toLowerCase();
  const normPath = (p) => String(p).replace(/\\/g, '/');
  const isAbsolute = (p) => /^(?:[A-Za-z]:[\\/]|[\\/])/.test(String(p));
  const PKG_TAIL = '/node_modules/@deepseek-ai/dsh/lib/bin.js';
  const isDshPackageEntry = (p) => {
    if (baseOf(p) !== 'bin.js') return false;
    const n = normPath(p);
    if (n.length <= PKG_TAIL.length || n.slice(-PKG_TAIL.length) !== PKG_TAIL) return false;
    const prefix = n.slice(0, -PKG_TAIL.length);
    try { return normPath(execPath.dshJsIn(prefix)) === n; } catch { return false; }
  };
  const isConfiguredDshBin = (p) => typeof dshBin === 'string' && dshBin !== '' && p === dshBin
    && !NODE_HEAD.has(baseOf(dshBin));
  const FORMS = '可用 [node, <绝对路径的 DSH 入口>, ...参数] 或 [<DSH 入口>, ...参数]';
  const sharedErr = execPath.commandEntryViolation(command, {
    requireAbsoluteEntry: true,
    files: execPath.knownDshEntries({ dshBin }),
    allowEntry: (entry) => isDshPackageEntry(entry) || DSH_ENTRY.has(baseOf(entry)) || isConfiguredDshBin(entry),
  });
  if (!sharedErr) return null;
  if (NODE_HEAD.has(baseOf(command[0]))) {
    const entry = command.length > 1 ? command[1] : '';
    if (!entry || !isAbsolute(entry)) {
      return 'command[0] 为 node 时，command[1] 必须是**绝对路径**的 DSH 入口（相对路径按沙箱 data 目录解析，已禁止）；' + FORMS;
    }
    return 'command[0] 为 node 时 command[1] 必须是 DSH 入口（dsh / dsh.js / lobox / lobox.js，'
      + '或 <前缀>/node_modules/@deepseek-ai/dsh/lib/bin.js）；' + FORMS;
  }
  return sharedErr + '；' + FORMS + '；需要其它可执行请走插件安装通道';
}

function handle(ctx) {
  const { sup, req, res, pathname, identity, send, collectBody, originAllowed, tokOf, browser, server } = ctx;
  function openInSystemBrowser(url) { return browser.openBrowser(url, { logger: sup.logger }); }

    if (req.method === 'GET' && pathname === '/open') return handleOpen(ctx);

    if (req.method === 'GET' && pathname === '/instances') {
      const decorate = (it) => {
        const tok = tokOf(it.id);
        const out = Object.assign({}, it);
        const loopback = identity.loopback;
        out.tokenSet = !!String(it.remoteToken || '').trim();
        if (!loopback) delete out.remoteToken;
        out.authUrl = (tok && loopback)
          ? ('http://127.0.0.1:' + it.port + '/?token=' + encodeURIComponent(tok))
          : ('http://127.0.0.1:' + it.port + '/');
        out.tokenPresent = loopback && !!tok;
        return out;
      };
      const render = () => {
        const sandboxes = (sup.instances.list() || []).filter((i) => i.domain === 'sandbox');
        const main = (sup.dshMainView && typeof sup.dshMainView === 'function') ? sup.dshMainView() : null;
        return send(200, {
          instances: sandboxes.map((it) => decorate(it)),
          native: main ? decorate(main) : null,
        });
      };
      return render();
    }
    if (req.method === 'POST' && pathname.startsWith('/instances/')) {
      if (!originAllowed(req)) { req.resume(); return send(403, {}); }
      const act = pathname.slice('/instances/'.length);
      collectBody(req, res, 65536, (body) => {
        try {
          const j = body ? JSON.parse(body) : {};
          if (act === 'add') {
            const cmdErr = commandShapeError(j.command, sup.instances && sup.instances.dshBin);
            if (cmdErr) return send(400, { ok: false, error: cmdErr });
            return Promise.resolve(sup.instances.addInstance(j))
              .then((r) => send(r && r.ok ? 200 : 400, r))
              .catch((e) => send(500, { ok: false, error: (e && e.message) || String(e) }));
          }
          if (j.id) {
            const target = sup.instances.find(j.id);
            if (target && target.domain === 'native' && act !== 'open-web') {
              const hint = (act === 'start' || act === 'stop' || act === 'restart')
                ? '原生主实例请经 /lifecycle/dsh/start|stop 启停'
                : '原生主实例请经 /native/* 管理（安装/升级/卸载/版本检测）';
              return send(400, { ok: false, error: hint });
            }
          }
          if (act === 'remove' && j.id) { return Promise.resolve(sup.instances.removeInstance(j.id)).then((r) => send(r && r.ok ? 200 : 400, r)).catch((e) => send(500, { ok: false, error: (e && e.message) || String(e) })); }
          if (act === 'update' && j.id) { const r = sup.instances.updateInstance(j.id, j); return send(r && r.ok ? 200 : 400, r); }
          if (act === 'start' && j.id) return Promise.resolve(sup.instances.startInstance(j.id, { manual: true }))
            .then((r) => send(r && r.ok ? 200 : 400, r))
            .catch((e) => send(500, { ok: false, error: e.message }));
          if (act === 'stop' && j.id) { return Promise.resolve(sup.instances.stopInstance(j.id)).then((r) => send(r && r.ok ? 200 : 400, r)).catch((e) => send(500, { ok: false, error: (e && e.message) || String(e) })); }
          if (act === 'open-web' && j.id) {
            try {
              const it = findInstanceOrMain(sup, j.id);
              if (!it) return send(404, { ok: false, error: '实例不存在' });
              if (!(Number(it.port) > 0)) return send(400, { ok: false, error: '非法端口' });
              const code = issueOpenWebCode(j.id);
              const url = 'http://127.0.0.1:' + (liveApiPort(server, sup) || sup.config.apiPort) + '/open?code=' + code;
              return Promise.resolve(openInSystemBrowser(url)).then((r) => {
                if (!r.ok) dropOpenWebCode(code);
                return send(r.ok ? 200 : 500, r);
              }).catch((e) => {
                dropOpenWebCode(code);
                return send(500, { ok: false, reason: 'spawn-failed', error: '打开浏览器失败：' + ((e && e.message) || e), url });
              });
            } catch (e) { return send(500, { ok: false, error: e.message }); }
          }
          if (act === 'check-update' && j.id) return Promise.resolve(sup.instances.checkUpdate(j.id)).then((r) => send(200, r)).catch((e) => send(500, { ok: false, error: e.message }));
          if (act === 'upgrade' && j.id) return Promise.resolve(sup.instances.upgradeInstance(j.id)).then((r) => send(200, r)).catch((e) => send(500, { ok: false, error: e.message }));
          if (act === 'upgrade/status' && j.id) return send(200, sup.instances.upgradeStatus(j.id));
          return send(404, { error: 'not found' });
        } catch (e) { return send(500, { ok: false, error: e.message }); }
      });
      return;
    }
  if (req.method === 'GET' || req.method === 'POST') return send(404, { error: 'not found', path: pathname });
  return send(405, { error: 'method not allowed' });
}

module.exports = { owns, handle, handleOpen, issueOpenWebCode, consumeOpenWebCode };
