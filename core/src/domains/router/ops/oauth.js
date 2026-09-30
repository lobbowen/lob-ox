'use strict';

// Command Code OAuth 一键登录（IO + 状态）。状态收敛于本工厂闭包；端口登记沿用
// platform/service/ports（分配即登记 / 配对释放）。
// 浏览器启动只声明意图（要用隔离窗口登录 + 关窗即取消），机制全在 platform/os/browser.js 的唯一出口：
// 本文件不建临时目录、不拼引擎参数、不解释 argv 结局，只认那一套三档结果词汇。

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
    // 轮次号：server 与浏览器监视闭包各带本轮 roundId，决议前比对（B2-6b）——
    //   旧轮 server 的 keep-alive 迟到回调能通过旧 state 自查，不挡就会把旧凭据
    //   注进新一轮 promise；close() 只挡新连接，挡不了在途请求。
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
            // B2-6b：非本轮的迟到回调一律 410 Gone，绝不触碰 st 上的决议器。
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
    // UI 只 start 不 wait —— _ccLoginReject 打到无人 await 的 promise 上会 unhandledRejection。
    // 这里挂一个空 catch 仅把该 rejection 标记为「已处理」，不改变 promise 本体的 settle 值：
    // commandcodeLoginWait 用的仍是同一 promise 本体，其 await/Promise.race 依旧收到同一 reject。
    promise.catch(() => {});
    st._ccLoginPromise = promise;
    const opened = await openInBrowser(authUrl, () => {
      // 旧轮浏览器的退出监视迟到时不得误杀新一轮登录。
      if (st._ccLoginRound !== roundId) return;
      if (st._ccLoginReject) {
        const r = st._ccLoginReject;
        st._ccLoginReject = null;
        st._ccLoginResolve = null;
        try { r(new Error('浏览器已关闭，登录已取消')); } catch {}
      }
    });
    // 唯一出口交回的三档结果（ok/confirmed/handedOff/reason/error/message/evidence）：
    // 本层只补登录专有字段，绝不自行宣称 confirmed。
    const r = opened || { ok: false, reason: 'spawn-failed' };
    const ev = r.evidence || {};
    if (!r.ok) {
      st._ccLoginPromise = null;
      st._ccLoginResolve = null;
      st._ccLoginReject = null;
      try { server.close(); } catch {}
      try { ports.unregister('oauth:' + state); } catch {}
      st._ccLogin = null;
      // authUrl 与 error 分字段回：面板必须能把地址原样交给用户（复制/手动打开），
      // 不再把 URL 埋在错误文案里。evidence 一并交出：里面是环境表单的分发依据与探测留痕，
      // 没有它，「为什么没弹出浏览器」在界面上永远只剩「再点一次」。
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
      // 非隔离引擎（Safari/打包器包装）由平台层降级：账号隔离不成立，换账号只能靠超时重发或手动窗口。
      isolated: ev.isolated === true,
      // 为什么隔离成立/不成立必须一起交出：面板上一句「未隔离」既没说原因也没法处置。
      //   basis 来自环境表单的出网条件维度（cold-profile-blocked 即冷档案注定空白），
      //   与「引擎不支持隔离」是两种不同原因，分开才谈得上分开修（配代理 vs 换浏览器）。
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
      // 失败分支也必须清 resolve/reject（防上一轮残留 reject 误杀下一次登录）。
      st._ccLoginResolve = st._ccLoginReject = null;
      return { ok: false, error: e.message };
    } finally {
      // 登录结束后延迟回收隔离 profile（60s 给浏览器进程落盘的时间）；回收机制在 util/fs 一处。
      if (tmpProfile) removeTreeDeferred(tmpProfile, 60 * 1000);
    }
  }

  return { commandcodeLoginStart, commandcodeLoginWait };
}

module.exports = { createOAuthOps };
