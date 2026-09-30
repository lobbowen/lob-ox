'use strict';

// ctl dispatcher —— daemon 的 127.0.0.1 回环控制通道（L0 平台层，不含域知识）：router/lan 各自向下注入本域
// 白名单（ROUTER_CTL_METHODS / LAN_CTL_METHODS），避免跨域反向依赖（DS-2）。安全面不可削弱：allowMethods 必填且
// fail-closed（缺省/空数组拒绝启动，绝不回退"放行全部"，PG-5）、`_` 前缀内部方法永不可达、仅绑回环、POST /ctl 过来源闸防 CSRF。

const http = require('node:http');

/** 白名单闸的唯一判据；导出以便单测直接断言"未登记/内部方法不可达"（PG-5），无需起真实 HTTP server。 */
const isMethodAllowed = (allowMethods, method) =>
  Array.isArray(allowMethods) && typeof method === 'string' && allowMethods.includes(method);

// 回环 Origin 形态（IPv4/IPv6/localhost，可带任意端口）。
const LOOPBACK_ORIGIN_RE = /^https?:\/\/(?:127\.0\.0\.1|\[::1\]|localhost)(?::\d{1,5})?$/i;

/** 来源闸：content-type 必须 application/json —— 合法客户端（platform/service/log/tail.js#ctlCall）固定发送，
 *  借此切断 form-urlencoded / text/plain / multipart 这些不触发 CORS 预检的盲打形态；
 *  携带 Origin 时必须指向回环自身（跨站浏览器请求必带受害者站点 Origin，非浏览器客户端不发 Origin）。
 *  @returns {string|null} 拒绝原因；null 表示通过。 */
function ctlSourceProblem(req) {
  const ct = String(req.headers['content-type'] || '');
  if (!/^application\/json\b/i.test(ct)) return 'content-type 必须为 application/json';
  const origin = req.headers.origin;
  if (origin !== undefined && !LOOPBACK_ORIGIN_RE.test(String(origin))) return 'Origin 非回环: ' + String(origin).slice(0, 80);
  return null;
}

/** 创建 ctl HTTP server，target 上的方法经 `target[method]` 调用。
 *  @param {{target:object, allowMethods:string[], logger?:{debug:Function,warn:Function,error:Function}, events?:object}} o
 *  allowMethods 为必填域白名单，缺省/非法直接抛错（fail-closed）；events 存在且 eventsTail 已列入白名单时
 *  暴露内置 eventsTail(afterSeq)，从守卫 EventHub 增量拉事件，不依赖 target 实例方法。 @returns {http.Server} */
function createCtlServer({ target, allowMethods, logger, events } = {}) {
  // 白名单是安全面的根：缺了就拒绝启动，不给"宽容缺省"。
  if (!Array.isArray(allowMethods) || allowMethods.length === 0) {
    throw new Error('createCtlServer: allowMethods（域方法白名单）必填且不能为空——白名单不可缺省（安全面 PG-5）');
  }
  const server = http.createServer((req, res) => {
    const send = (code, obj) => {
      let body;
      try { body = JSON.stringify(obj); } catch { body = JSON.stringify({ ok: false, error: 'response not serializable' }); }
      res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
      res.end(body);
    };

    if (req.method === 'GET' && req.url === '/health') {
      return send(200, { ok: true, pid: process.pid });
    }
    if (req.method !== 'POST' || req.url !== '/ctl') {
      return send(404, { ok: false, error: 'not found' });
    }
    // 来源闸：先闸后读体，非法形态不消耗 body。
    const srcBad = ctlSourceProblem(req);
    if (srcBad) {
      if (logger && logger.warn) logger.warn('[ctl] 来源闸拒绝: ' + srcBad);
      try { req.resume(); } catch {}
      return send(403, { ok: false, error: 'ctl source gate: ' + srcBad });
    }

    let body = '';
    let settled = false;
    req.on('data', (c) => {
      if (settled) return;
      body += c;
      if (body.length > 1 << 20) { // 1MB 上限
        settled = true;
        send(413, { ok: false, error: 'payload too large' });
        req.destroy();
      }
    });
    req.on('end', () => {
      if (settled) return;
      let m = null;
      try { m = JSON.parse(body || '{}'); } catch { return send(400, { ok: false, error: 'bad json' }); }
      const method = m && typeof m.method === 'string' ? m.method : null;
      const args = Array.isArray(m && m.args) ? m.args : [];
      // 内置 eventsTail(afterSeq)：守卫 EventHub 增量拉取事件。内置特例不等于无条件放行：
      // 同样要过白名单（调用方白名单里写了才可达）。
      if (method === 'eventsTail' && isMethodAllowed(allowMethods, method)
          && events && typeof events.tailSince === 'function') {
        const afterSeq = Number(args[0]) || 0;
        let list = [];
        try { list = events.tailSince(afterSeq); } catch (e2) { return send(200, { ok: false, error: (e2 && e2.message) || String(e2) }); }
        return send(200, { ok: true, value: { seq: events.seq, events: list } });
      }
      // 白名单闸（PG-5）：未登记的方法一律 404——不对调用方透露"存在与否"；
      // 内部方法（_ 前缀）不在各域表内，故永不可达。
      if (!isMethodAllowed(allowMethods, method) || !target || typeof target[method] !== 'function') {
        if (logger && logger.warn && method) logger.warn('[ctl] 拒绝未登记方法: ' + method);
        return send(404, { ok: false, error: 'method not allowed: ' + method });
      }
      const started = Date.now();
      Promise.resolve()
        .then(() => target[method].apply(target, args))
        .then((value) => {
          if (logger && logger.debug) logger.debug('[ctl] ' + method + ' ok in ' + (Date.now() - started) + 'ms');
          send(200, { ok: true, value });
        })
        .catch((e) => {
          if (logger && logger.warn) logger.warn('[ctl] ' + method + ' error: ' + ((e && e.message) || e));
          send(200, { ok: false, error: (e && e.message) || String(e) });
        });
    });
    req.on('error', () => { try { res.end(); } catch {} });
  });
  server.on('error', (e) => { if (logger) logger.error('[ctl] server error: ' + e.message); });
  // 守卫（Node>=19 globalAgent keepAlive=true）以池化长连复用 ctl；默认 keepAliveTimeout=5s
  // 会回收空闲连接，导致下次复用已关 socket、间歇 'socket hang up'，上层据此回退陈旧本地视图。
  // 与 router 供应商端点对齐（index.js keepAliveTimeout=65000），长连不因空闲被服务端回收。
  server.keepAliveTimeout = 65000;
  server.headersTimeout = 70000;
  server.requestTimeout = 120000;
  return server;
}

module.exports = { createCtlServer, isMethodAllowed, ctlSourceProblem };
