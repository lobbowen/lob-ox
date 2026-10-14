'use strict';

const crypto = require('node:crypto');
const { createServer } = require('node:http');
const { removeTreeDeferred } = require('../../../platform/util/fs');

function createOAuthOps(deps) {
  const d = deps || {};
  const ports = d.ports;
  const openInBrowser = d.openInBrowser;
  const st = { _ccLogin: null, _ccLoginPromise: null, _ccLoginResolve: null, _ccLoginReject: null, _ccLoginRound: 0 };

  async function commandcodeLoginStart() {
    const STUDIO_BASE = 'https://commandcode.ai';
    const state = crypto.randomBytes(32).toString('base64url');
    const roundId = ++st._ccLoginRound;
    if (st._ccLogin && st._ccLogin.server) {
      const oldState = st._ccLogin.state;
      try { st._ccLogin.server.close(); } catch {}
      if (oldState) { try { ports.unregister('oauth:' + oldState); } catch {} }
      st._ccLogin = null;
    }
    if (st._ccLoginReject) { try { st._ccLoginReject(new Error('登录已取消（重新发起）')); } catch {} }
    st._ccLoginPromise = null;
    st._ccLoginResolve = null;
    st._ccLoginReject = null;
    let port = null;
    let server = null;
    let base = await ports.allocate('oauthCallback', 'oauth:' + state);
    for (let i = 0; i < 5 && !server && base !== null; i++) {
      port = base + i;
      try {
        const callbackJson = (obj) => JSON.stringify(obj);
        const corsOrigin = (origin) => { const allowed = ['http://localhost:3000', 'https://staging.commandcode.ai', 'https://commandcode.ai']; return allowed.includes(origin) ? origin : allowed[0]; };
        const s = createServer((req, res) => {
          res.setHeader('Access-Control-Allow-Origin', corsOrigin(req.headers.origin));
          res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
          res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
          res.setHeader('Content-Type', 'application/json');
          if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
          const cbPath = String(req.url || '').split('?')[0].split('#')[0];
          if (cbPath !== '/callback') { res.writeHead(404); res.end(callbackJson({ success: false, error: 'Not found' })); return; }
          if (req.method !== 'POST') { res.writeHead(405); res.end(callbackJson({ success: false, error: 'Method not allowed. Use POST.' })); return; }
          let b = '';
          req.on('data', (c) => { b += c; if (b.length > 10000) req.destroy(); });
          req.on('end', () => {
            if (st._ccLoginRound !== roundId) { res.writeHead(410); res.end(callbackJson({ success: false, error: 'Stale login round' })); return; }
            try {
              const j = JSON.parse(b || '{}');
              if (j && typeof j === 'object' && 'error' in j) {
                res.writeHead(200); res.end(callbackJson({ success: true }));
                if (st._ccLoginReject) { st._ccLoginReject(new Error(j.error_description || j.error || 'Authorization denied')); st._ccLoginReject = null; }
                return;
              }
              const valid = j && typeof j.apiKey === 'string' && typeof j.state === 'string' && typeof j.userId === 'string' && typeof j.userName === 'string' && typeof j.keyName === 'string';
              if (!valid) { res.writeHead(400); res.end(callbackJson({ success: false, error: 'Missing required fields' })); return; }
              if (j.state !== state) { res.writeHead(400); res.end(callbackJson({ success: false, error: 'Invalid state parameter' })); if (st._ccLoginReject) { st._ccLoginReject(new Error('Invalid state parameter')); st._ccLoginReject = null; } return; }
              res.writeHead(200); res.end(callbackJson({ success: true }));
              if (st._ccLoginResolve) { st._ccLoginResolve({ apiKey: j.apiKey, userId: j.userId, userName: j.userName, keyName: j.keyName }); st._ccLoginResolve = null; }
            } catch (e) { res.writeHead(400); res.end(callbackJson({ success: false, error: 'bad request' })); }
          });
        });
        await new Promise((resolve, reject) => {
          const onErr = (err) => { try { s.removeListener('listening', onOk); } catch {}; reject(err); };
          const onOk = () => { try { s.removeListener('error', onErr); } catch {}; resolve(); };
          s.once('error', onErr);
          s.once('listening', onOk);
          s.listen(port, '127.0.0.1');
        });
        server = s;
      } catch {}
    }
    if (!server) {
      try { ports.unregister('oauth:' + state); } catch {}
      return { ok: false, error: '无法启动本地回调端口（oauthCallback 段已满）' };
    }
    if (port !== base) {
      try { ports.unregister('oauth:' + state); } catch {}
      try { ports.allocateMark(port, 'oauthCallback', 'oauth:' + state); } catch {}
    }
    const callbackUrl = 'http://localhost:' + port + '/callback';
    const authUrl = STUDIO_BASE + '/studio/auth/cli?callback=' + encodeURIComponent(callbackUrl) + '&state=' + encodeURIComponent(state);
    const promise = new Promise((resolve, reject) => { st._ccLoginResolve = resolve; st._ccLoginReject = reject; });
    
    promise.catch(() => {});
    st._ccLoginPromise = promise;
    const opened = await openInBrowser(authUrl, () => {
      if (st._ccLoginRound !== roundId) return;
      if (st._ccLoginReject) {
        const r = st._ccLoginReject;
        st._ccLoginReject = null;
        st._ccLoginResolve = null;
        try { r(new Error('浏览器已关闭，登录已取消')); } catch {}
      }
    });
    const r = opened || { ok: false, reason: 'spawn-failed' };
    const ev = r.evidence || {};
    if (!r.ok) {
      st._ccLoginPromise = null;
      st._ccLoginResolve = null;
      st._ccLoginReject = null;
      try { server.close(); } catch {}
      try { ports.unregister('oauth:' + state); } catch {}
      st._ccLogin = null;
      return {
        ok: false, authUrl, url: authUrl, opened: false, confirmed: false, handedOff: false,
        reason: r.reason || 'no-launcher',
        evidence: r.evidence || null,
        error: (r.error || '无法调起系统浏览器') + '，请手动打开下方地址完成授权',
      };
    }
    st._ccLogin = { state, port, server, tmpProfile: ev.profile || null };
    return Object.assign({}, r, {
      ok: true, authUrl, url: authUrl, state, port, waitMs: 180000, opened: true,
      isolated: ev.isolated === true,
      isolatedBasis: ev.egress ? ev.egress.basis : (ev.isolated === true ? 'isolated' : 'engine-not-isolatable'),
      isolatedDetail: ev.egress ? ev.egress.detail || null : null,
    });
  }

  async function commandcodeLoginWait(timeoutMs) {
    const p = st._ccLoginPromise;
    if (!p) return { ok: false, error: '未在登录中' };
    const tmpProfile = st._ccLogin ? st._ccLogin.tmpProfile : null;
    const timeout = timeoutMs || 180000;
    try {
      const cred = await Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('登录超时')), timeout))]);
      if (st._ccLogin && st._ccLogin.server) { const s = st._ccLogin.state; try { st._ccLogin.server.close(); } catch {} if (s) { try { ports.unregister('oauth:' + s); } catch {} } st._ccLogin = null; }
      st._ccLoginPromise = null;
      st._ccLoginResolve = st._ccLoginReject = null;
      return { ok: true, apiKey: cred && cred.apiKey, userId: cred && cred.userId, userName: cred && cred.userName, keyName: cred && cred.keyName };
    } catch (e) {
      if (st._ccLogin && st._ccLogin.server) { const s = st._ccLogin.state; try { st._ccLogin.server.close(); } catch {} if (s) { try { ports.unregister('oauth:' + s); } catch {} } st._ccLogin = null; }
      st._ccLoginPromise = null;
      st._ccLoginResolve = st._ccLoginReject = null;
      return { ok: false, error: e.message };
    } finally {
      if (tmpProfile) removeTreeDeferred(tmpProfile, 60 * 1000);
    }
  }

  return { commandcodeLoginStart, commandcodeLoginWait };
}

module.exports = { createOAuthOps };
