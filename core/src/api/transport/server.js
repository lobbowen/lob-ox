'use strict';

// api/transport/server —— 本地 HTTP 网关本体（传输层原语，与安全模型、域分派无关）。
// 注：api 契约面扫描只扫 api 顶层 + api/domains/，网关里的静态资源路由字面量不属于契约面。
const http = require('node:http');

const { API_DOMAINS } = require('../router-table');
const { collectBody } = require('./body');
const { serveStatic } = require('../static');
const { identify } = require('../identity');
const { originAllowed, requestHasAccessKey, isShellOrigin } = require('../security');
// 外部打开的唯一出口（platform/os/browser）。随 ctx 交给各域，是为了让 HTTP 契约测试在**构造期**
//   注入假出口：域内自己 require 的话，测试只能去 patch 模块导出，而 patch 是否生效取决于消费方是
//   解构还是按属性取用（test-safety-gate A 条记的正是这种 patch 静默失效后跑了真实副作用的事故）。
const browserExit = require('../../platform/os/browser');
// 环境表单（本机实况 + 分发依据，只读面）。与浏览器出口同一个注入范式：面板的「环境」区块与
//   打开失败的定档依据都取自这一份，测试在构造期注入假表单，域内不自取平台模块。
const environmentExit = require('../../platform/os/environment');

/** 请求级失败的统一兜底：只应答一次（头已发则仅断开），并记录一条错误事件。
 *  绝不把异常抛给进程层。 */
function safeFail(res, err, where) {
  try {
    const body = JSON.stringify({ ok: false, error: (err && err.message) || String(err) });
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
    }
    try { res.end(body); } catch {}
  } catch {}
  try { console.error('[api] handler error (' + (where || '?') + '):', (err && err.stack) || err); } catch {}
}

function createServer(sup, deps) {
  // deps.browser 只用于注入假出口；缺省即平台层唯一出口（生产路径不经任何加工）。
  const browser = (deps && deps.browser) || browserExit;
  // 环境表单同范式：只读面，测试注入假表单即可断言面板拿到的字段集。
  const environment = (deps && deps.environment) || environmentExit;
  return http.createServer((req, res) => {
    // 壳源 CORS 白名单与 CSRF 判定（isShellOrigin）共用同一事实源：
    // 此处若自带更宽字面量，会造成 CORS 松于 CSRF——子源能读响应却驱动不了写请求。
    const shellOrigin = (() => {
      const o = req.headers.origin;
      if (!o) return null;
      try {
        const u = new URL(o);
        return isShellOrigin(u.protocol, u.hostname) ? o : null;
      } catch {}
      return null;
    })();
    const send = (code, obj) => {
      const body = JSON.stringify(obj);
      const hdrs = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) };
      if (shellOrigin) { hdrs['Access-Control-Allow-Origin'] = shellOrigin; hdrs['Access-Control-Allow-Methods'] = 'GET,POST,OPTIONS'; hdrs['Access-Control-Allow-Headers'] = 'Content-Type,Authorization'; }
      res.writeHead(code, hdrs);
      res.end(body);
    };

    // DSH 访问令牌随实例重启轮换，唯一权威来源是 DshTokenService（原生与沙箱共用）；
    // 按目标实例查取，绝不跨实例借用（主实例令牌套到沙箱实例会 401）。
    const tokOf = (id) => {
      try { if (sup.tokenService && typeof sup.tokenService.get === 'function') return sup.tokenService.get(id) || ''; } catch {}
      return '';
    };

    // 访问者身份（socket 事实）：token 下发 / access-key 豁免一律消费 identity.loopback，
    // 绝不从请求头推断来源。唯一判定入口见 ../identity.js。
    const identity = identify(req);

    // 访问密钥门卫（apiAccessKey 可选配置），fail-closed：非回环请求（局域网 / FRP 通道）
    // 必须携带匹配的 key，未配置 key 时同样拒绝——否则 apiHost='0.0.0.0' 且未设 key 时，
    // 局域网任意主机可零认证驱动写 API。回环与 OPTIONS 预检豁免（预检不发自定义头，给 204）。
    const accessKey = (sup && sup.config && sup.config.apiAccessKey) || null;
    if (!identity.loopback && req.method !== 'OPTIONS' && (!accessKey || !requestHasAccessKey(req, accessKey))) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      const why = accessKey
        ? '需要访问密钥（apiAccessKey）：请求头 Authorization: Bearer <key> 或 ?access_key=<key>'
        : '未配置访问密钥（apiAccessKey）：非回环请求一律拒绝。请先设置访问密钥，或将 apiHost 收回 127.0.0.1';
      return res.end(JSON.stringify({ error: why }));
    }

    // OPTIONS 预检：壳源放行（含 Allow-*），其余跨站预检不给任何 CORS 头
    if (req.method === 'OPTIONS') {
      if (shellOrigin) {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': shellOrigin,
          'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type,Authorization',
          'Access-Control-Max-Age': '600',
        });
      } else {
        res.writeHead(204);
      }
      return res.end();
    }

    let pathname;
    try {
      pathname = new URL(req.url, 'http://localhost').pathname;
    } catch {
      return send(400, { error: 'bad request' });
    }


    // 路径段安全解码（单点）：畸形百分号编码返回 400；域 handler 只拿已解码的干净字符串，
    // 任何域不得自行 decodeURIComponent（异常边界唯一化）。
    let decodedPathname;
    try {
      decodedPathname = pathname.split('/').map((seg) => {
        try { return decodeURIComponent(seg); } catch { throw new Error('bad encoding'); }
      }).join('/');
    } catch (e) {
      return send(400, { error: 'bad request encoding' });
    }

    const ctx = { sup, req, res, pathname: decodedPathname, identity, send, collectBody, originAllowed, tokOf, browser, environment };

    // 按域分派（每域 owns 为粗前缀超集；域内未匹配由该域 handle 兜底 404/405）。
    // handler 同步抛错 / 返回的 Promise reject 一律在此兜底为 500，
    // 绝不穿透为进程级 uncaughtException。
    for (const d of API_DOMAINS) {
      if (d.owns(pathname)) {
        try {
          const out = d.handle(ctx);
          if (out && typeof out.catch === 'function') out.catch((e) => safeFail(res, e, 'handler'));
        } catch (e) { safeFail(res, e, 'handler'); }
        return;
      }
    }

    // 静态托管（React UI 产物：assets/ 哈希文件开放）
    if (req.method === 'GET') {
      if (pathname === '/' || pathname === '/index.html' || pathname === '/supervisor.html') {
        return serveStatic(res, 'supervisor.html', shellOrigin);
      }
      const file = pathname.slice(1);
      if (file.startsWith('assets/') || file === 'dsh-logo.svg') {
        return serveStatic(res, file, shellOrigin);
      }
    }

    if (req.method === 'GET' || req.method === 'POST') {
      return send(404, { error: 'not found', path: pathname });
    }
    return send(405, { error: 'method not allowed' });
  });
}

module.exports = { createServer };
