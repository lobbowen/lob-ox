'use strict';

// 架构回归：relay 透传上游 path+query 时必须逐字节保真，仅剥离「我方」门卫令牌参数，
// 绝不能用 WHATWG URL + searchParams 重建——那会把 DSH 的文档相对 combo 路由
// /plugins/??@deepseek-ai/dsh-client-modules/client.js 里的 '/' 编码成 %2F，
// 使 DSH combo 路由 404、client-modules 引导注册（window.__ModuleLoader__.load({id,factory})）
// 永不执行，浏览器抛出 "HTML did not preload @deepseek-ai/dsh-client-modules/client.js"。
//
// 本测试三类断言：
//   1) upstreamPath/redactLogPath 对 combo URL 的 '/' 逐字节保留（核心回归）；
//   2) 我方门卫 ?token=<secret> 被剥离、其余参数原样；
//   3) 端到端：起 mock-DSH（仅对字面 '/' 的 combo 返回 200，对 %2F 返回 404），
//      经 createRelay 转发后 combo 可达且含 client-modules 引导注册，根 HTML 完好。

const http = require('node:http');
const pathMod = require('node:path');
const ROOT = pathMod.join(__dirname, '..');
const { createRelay } = require(pathMod.join(ROOT, 'src', 'domains', 'relay'));
const core = require(pathMod.join(ROOT, 'src', 'domains', 'relay', 'core.js'));

let failures = 0;
function check(name, ok, extra) {
  if (ok) console.log('  PASS ' + name);
  else { failures++; console.log('  FAIL ' + name + (extra ? ' :: ' + extra : '')); }
}
function req(port, method, p, headers) {
  return new Promise((resolve) => {
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers, timeout: 5000 }, (res) => {
      const buf = [];
      res.on('data', (d) => buf.push(d));
      res.on('end', () => resolve({ code: res.statusCode, body: Buffer.concat(buf), headers: res.headers }));
    });
    r.on('error', (e) => resolve({ code: 0, body: Buffer.from(e.message), headers: {} }));
    r.end();
  });
}
const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', r));

async function main() {
  const COMBO = '/plugins/??@deepseek-ai/dsh-client-modules/client.js&rev=36e36544670f';

  console.log('== A. upstreamPath 对 combo/查询逐字节保真（核心回归）==');
  check('combo: 字面 "/" 在 id 内保留、无 %2F',
    core.upstreamPath(COMBO) === COMBO && !core.upstreamPath(COMBO).includes('%2F'),
    core.upstreamPath(COMBO));
  check('combo: 文档相对（含 ?? 组合）整串原样',
    core.upstreamPath(COMBO) === '/plugins/??@deepseek-ai/dsh-client-modules/client.js&rev=36e36544670f');

  console.log('== B. 仅剥离我方门卫 token，其余参数原样 ==');
  const cases = [
    ['/x?a=1&token=abc', '/x?a=1'],
    ['/?token=', '/'],
    ['/keep?a=1&b=2', '/keep?a=1&b=2'],
    // 非门卫、恰巧也叫 token 的其它用途不应被误删（仅剥离 ?token= 顶层键）
    [COMBO + '&token=lan-secret', COMBO],
    ['/plugins/??a/b.js&token=x&rev=1', '/plugins/??a/b.js&rev=1'],
  ];
  for (const [input, want] of cases) {
    check('upstreamPath: ' + input + ' -> ' + want, core.upstreamPath(input) === want, core.upstreamPath(input));
  }
  // redactLogPath 与 upstreamPath 同源保真（日志不重写 URL，不泄露 token）
  check('redactLogPath 同样剥离 token 且保留 combo 的 /',
    core.redactLogPath(COMBO + '&token=secret') === COMBO, core.redactLogPath(COMBO + '&token=secret'));

  console.log('== C. 端到端：relay 转发 combo 必须 200（不 404）且含引导注册 ==');
  // mock-DSH：仅当 path 为字面 combo 时 200；若被编码成 %2F 则返回 404（复刻 DSH 真实路由行为）。
  const upstream = http.createServer((q, s) => {
    const url = new URL(q.url, 'http://127.0.0.1');
    if (url.pathname === '/' && url.searchParams.get('token') === 'lan-secret') {
      s.writeHead(303, { location: '/', 'set-cookie': 'dsh-auth-mock=abc; Path=/; HttpOnly' });
      return s.end();
    }
    if (q.url === COMBO) {
      const body = 'window.__ModuleLoader__.load({id:"@deepseek-ai/dsh-client-modules",factory:function(){}});';
      s.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
      return s.end(body);
    }
    if (q.url.includes('%2F')) { // 编码过的 combo -> DSH 真实就是 404
      s.writeHead(404);
      return s.end();
    }
    s.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    s.end('<html><head></head><body>ok</body></html>');
  });
  await listen(upstream);
  const targetPort = upstream.address().port;

  const relay = createRelay('127.0.0.1', targetPort, { token: 'lan-secret', dshToken: 'lan-secret' });
  await listen(relay);
  const relayPort = relay.address().port;

  const hs = await req(relayPort, 'GET', '/?token=lan-secret');
  const sc = String((hs.headers['set-cookie'] || []).join(';'));
  const lanCk = 'lobox_lan_token=' + ((/lobox_lan_token=([^;]+)/.exec(sc) || [])[1] || '');
  check('先换 LAN 派生 cookie（302）', hs.code === 302 && !!lanCk.split('=')[1], hs.code + ' ' + sc);

  const comboViaRelay = await req(relayPort, 'GET', COMBO, { Cookie: lanCk });
  check('combo 经 relay 转发 -> 200（非 404）', comboViaRelay.code === 200, String(comboViaRelay.code));
  check('combo 经 relay 含 client-modules 引导注册',
    comboViaRelay.body.toString('utf8').includes('window.__ModuleLoader__.load({id:"@deepseek-ai/dsh-client-modules"') ||
    comboViaRelay.body.toString('utf8').includes('id:"@deepseek-ai/dsh-client-modules"'),
    comboViaRelay.body.toString('utf8').slice(0, 120));

  const rootViaRelay = await req(relayPort, 'GET', '/', { Cookie: lanCk });
  check('根 HTML 经 relay 转发 -> 200', rootViaRelay.code === 200, String(rootViaRelay.code));

  await new Promise((r) => relay.close(r));
  await new Promise((r) => upstream.close(r));

  console.log(failures === 0 ? '\nrelay-upstream-path-fidelity-test: ALL PASS' : '\nrelay-upstream-path-fidelity-test: ' + failures + ' FAILED');
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
