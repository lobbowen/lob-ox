#!/usr/bin/env node
'use strict';

// Cookie 属性断言：/open 的 Set-Cookie 用 SameSite=Strict（src/api/domains/instances.js 拼出），
//   LAN 门卫 cookie 用 SameSite=Lax（src/domains/relay/core.js）—— 属性写错不改变「能不能访问」，
//   而改变**跨站是否携带**，属安全面。

const path = require('node:path');
const ROOT = path.join(__dirname, '..');

const results = [];
const check = (n, c, x) => {
  results.push(!!c);
  console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined ? '  <- ' + x : ''));
};

// 1. LAN 门卫 cookie：SameSite=Lax + HttpOnly + Path=/ + 只存派生值。
{
  const core = require(path.join(ROOT, 'src', 'domains', 'relay', 'core.js'));
  if (typeof core.tokenGateDecision !== 'function') {
    check('门卫决策口可调用（fail-closed：取不到即判红，不得静默跳过）', false, 'tokenGateDecision 未导出');
  } else {
    const d = core.tokenGateDecision({ url: '/?token=lan-secret', headers: {} }, 'lan-secret', 'salt-A');
    const ck = String((d && d.cookie) || '');
    check('门卫：首次凭 URL 令牌进入 → 302 目标 + 种 cookie',
      !!d && d.ok === false && typeof d.redirect === 'string' && !!ck, JSON.stringify(d));
    check('门卫 cookie 带 Path=/、HttpOnly 与 SameSite=Lax（杜绝跨站携带；此前零覆盖）',
      /(^|;\s*)Path=\//.test(ck) && /HttpOnly/.test(ck) && /SameSite=Lax/.test(ck), ck);
    check('门卫 cookie 只存派生 64hex 且不含令牌原文',
      /^dsh_lan_token=[0-9a-f]{64}(;|$)/.test(ck) && !ck.includes('lan-secret'), ck);
    // 已持有效派生 cookie 时直接放行。
    const okReq = { url: '/', headers: { cookie: 'dsh_lan_token=' + core.lanGateCookieValue('lan-secret', 'salt-A') } };
    check('门卫：持有效派生 cookie → 放行', core.tokenGateDecision(okReq, 'lan-secret', 'salt-A').ok === true);
  }
}

// 2. /open 的 Set-Cookie：SameSite=Strict + Location 用实例真实端口。
(async () => {
  const EXCH = path.join(ROOT, 'src', 'platform', 'service', 'token', 'exchange.js');
  const INST = path.join(ROOT, 'src', 'api', 'domains', 'instances.js');
  const seen = [];
  try {
    // 注入：不真发回环请求，返回可识别的派生 cookie 值。
    require.cache[EXCH] = {
      id: EXCH, filename: EXCH, loaded: true,
      exports: {
        bootstrapDshCookie: (host, port, tok) => {
          seen.push({ host, port, tok });
          return Promise.resolve('dsh-auth-abc=derived123');
        },
      },
    };
    delete require.cache[INST];
    const inst = require(INST);

    if (typeof inst.handleOpen !== 'function' || typeof inst.issueOpenWebCode !== 'function') {
      check('/open 驱动口可调用（fail-closed）', false, 'handleOpen/issueOpenWebCode 未导出');
    } else {
      const code = inst.issueOpenWebCode('sb1');
      let head = null;
      const res = { writeHead: (s, h) => { head = { s, h }; }, end: () => {} };
      const ctx = {
        sup: { config: { apiPort: 3000 }, instances: { list: () => [{ id: 'sb1', port: 28222 }] } },
        // url 由 req.url 自解析（网关 ctx 不含 url 键）
        req: { url: '/open?code=' + code, headers: { host: '127.0.0.1:3000' } },
        res,
        identity: { loopback: true },
        originAllowed: () => true,
        tokOf: () => 'tok-xyz',
      };
      await inst.handleOpen(ctx);
      const h = (head && head.h) || {};
      const sc = String(h['Set-Cookie'] || '');
      check('/open：303 且带 Set-Cookie', !!head && head.s === 303 && !!sc, JSON.stringify(head));
      check('/open cookie 带 Path=/ 与 HttpOnly，且带 SameSite=Strict（跨端口共享是设计意图，故须 Strict；此前零覆盖）',
        /(^|;\s*)Path=\//.test(sc) && /HttpOnly/.test(sc) && /SameSite=Strict/.test(sc), sc);
      check('/open Location 用实例真实端口 + 回环主机（绝不取自请求参数）',
        h.Location === 'http://127.0.0.1:28222/', String(h.Location));
      check('/open 把实例真实端口与令牌交给换 cookie 口（不硬编码）',
        seen.length === 1 && seen[0].host === '127.0.0.1' && seen[0].port === 28222 && seen[0].tok === 'tok-xyz',
        JSON.stringify(seen));
      check('/open 授权码一次性（同码二用 → 400/404，不得再次种 cookie）', await (async () => {
        let head2 = null;
        const res2 = { writeHead: (s, hh) => { head2 = { s, hh }; }, end: () => {} };
        await inst.handleOpen(Object.assign({}, ctx, { res: res2 }));
        return !!head2 && (head2.s === 400 || head2.s === 404) && !head2.hh['Set-Cookie'];
      })());
    }
  } catch (e) {
    check('/open 驱动未抛异常', false, (e && e.stack) || String(e));
  } finally {
    delete require.cache[EXCH];
    delete require.cache[INST];
  }

  const failed = results.filter((r) => !r);
  console.log('\n结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
