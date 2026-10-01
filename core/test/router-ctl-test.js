'use strict';


const http = require('node:http');
const path = require('node:path');
const { createCtlServer, isMethodAllowed } = require(path.join(__dirname, '..', 'src', 'platform', 'ctl', 'server'));
const WHITELIST = Object.freeze([
  'status', 'addProxyKey', 'listProviders', 'refreshProviderQuota', 'removeProvider',
  'eventsTail', // dispatcher 内置特例（守卫 EventHub）；登记了才可达
]);

let failures = 0;
function check(name, ok, extra) {
  if (ok) console.log('  PASS ' + name);
  else { failures++; console.log('  FAIL ' + name + (extra !== undefined ? ' :: ' + JSON.stringify(extra) : '')); }
}

function fakeRouter() {
  return {
    _calls: [],
    status() { return { running: true, mode: 'daemon' }; },
    addProxyKey(id, key) { this._calls.push(['addProxyKey', id, key]); return { ok: true }; },
    async listProviders() { return { providers: [{ id: 'p1' }] }; },
    // 测试替身必须复用白名单内的方法名来验证异步/异常语义（任意方法名会被白名单正确拒绝，那是设计意图而非缺陷）。
    async refreshProviderQuota(id, deep) { await new Promise((r) => setTimeout(r, 20)); return { id, deep }; },
    removeProvider(id) { if (!id) throw new Error('boom'); return { ok: true, removed: id }; },
    _internalSecret() { return 'should-never-be-reachable'; },
  };
}

function ctlPost(port, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = http.request({ host: '127.0.0.1', port, path: '/ctl', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => { try { resolve({ code: res.statusCode, json: JSON.parse(b) }); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.end(body);
  });
}
function ctlGet(port, urlPath) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: urlPath }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => { try { resolve({ code: res.statusCode, json: JSON.parse(b) }); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

async function main() {
  const router = fakeRouter();
  let threw = false;
  try { createCtlServer({ target: router }); } catch { threw = true; }
  check('PG-5 未注入 allowMethods → 拒绝启动（fail-closed）', threw);
  check('PG-5 isMethodAllowed 判据：登记可达 / 内部方法不可达',
    isMethodAllowed(WHITELIST, 'status') === true && isMethodAllowed(WHITELIST, '_save') === false
    && isMethodAllowed(WHITELIST, 'eventsTail') === true && isMethodAllowed(WHITELIST, 'noSuchMethod') === false);
  const server = createCtlServer({ target: router, allowMethods: WHITELIST });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;

  const h = await ctlGet(port, '/health');
  check('GET /health ok', h.code === 200 && h.json.ok === true, h);

  const r1 = await ctlPost(port, { method: 'addProxyKey', args: ['prov-1', 'sk-xxx'] });
  check('同步方法 ok:true 且参数按序透传', r1.code === 200 && r1.json.ok === true
    && JSON.stringify(router._calls[0]) === JSON.stringify(['addProxyKey', 'prov-1', 'sk-xxx']), router._calls);

  const r2 = await ctlPost(port, { method: 'listProviders' });
  const r3 = await ctlPost(port, { method: 'refreshProviderQuota', args: ['p1', true] });
  check('异步方法正确返回、多参正确透传',
    r2.json.ok === true && r2.json.value.providers.length === 1 && r3.json.ok === true && r3.json.value.deep === true && r3.json.value.id === 'p1', r3.json);

  const r4 = await ctlPost(port, { method: 'noSuchMethod', args: [] });
  check('未知方法返回 404', r4.code === 404 && r4.json.ok === false, r4);

  const r5 = await ctlPost(port, { method: 'removeProvider', args: [] });
  check('方法异常 → ok:false error=boom', r5.json.ok === false && r5.json.error === 'boom', r5.json);

  const r6 = await ctlPost(port, { method: '_internalSecret', args: [] });
  const r7 = await ctlPost(port, { method: '_save', args: [] });
  check('PG-5 未登记/内部方法被拒绝（白名单闸：_internalSecret 与 _save 均 404）',
    r6.code === 404 && r6.json.ok === false && r7.code === 404 && r7.json.ok === false, r6.json);

  const bad = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/ctl', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': 5 } }, (res) => {
      let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ code: res.statusCode, json: JSON.parse(b) }));
    });
    req.on('error', reject);
    req.end('{oops');
  });
  check('非法 JSON → 400', bad.code === 400, bad);

  const { ctlSourceProblem } = require(path.join(__dirname, '..', 'src', 'platform', 'ctl', 'server'));
  check('B-2 纯判据：text/plain 盲打被拒（不触发预检的 CSRF 形态）',
    !!ctlSourceProblem({ headers: { 'content-type': 'text/plain' } }), 'hit');
  check('B-2 纯判据：合法客户端（json、无 Origin）通过',
    ctlSourceProblem({ headers: { 'content-type': 'application/json; charset=utf-8' } }) === null, 'ok');
  const rawPost = (headers, body) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/ctl', method: 'POST', headers }, (res) => {
      let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => { try { resolve({ code: res.statusCode, json: JSON.parse(b) }); } catch { resolve({ code: res.statusCode, json: null }); } });
    });
    req.on('error', reject);
    req.end(body);
  });
  const csrf = await rawPost({ 'Content-Type': 'text/plain;charset=UTF-8' }, '{"method":"status","args":[]}');
  check('B-2 行为：text/plain JSON 盲打 → 403 且方法未执行', csrf.code === 403 && csrf.json && csrf.json.ok === false, csrf);
  const evilOrigin = await rawPost({ 'Content-Type': 'application/json', Origin: 'https://evil.example' }, '{"method":"status","args":[]}');
  check('B-2 行为：跨站 Origin 的 application/json → 403', evilOrigin.code === 403 && evilOrigin.json && evilOrigin.json.ok === false, evilOrigin);
  const okPost = await rawPost({ 'Content-Type': 'application/json' }, '{"method":"status","args":[]}');
  check('B-2 反向防空转：合法 JSON 无 Origin 仍 200（客户端链路未破坏）', okPost.code === 200 && okPost.json.ok === true, okPost);

  server.close();
  console.log(failures === 0 ? '\nrouter-ctl-test: ALL PASS' : '\nrouter-ctl-test: ' + failures + ' FAILURES');
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
