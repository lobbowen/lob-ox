'use strict';

// router-ctl 控制通道测试：GET /health 存活；POST /ctl 同步/异步/参数透传/未知方法/方法抛错；
// 守卫侧 routerCtlCall 语义（{ok:true,value} / {ok:false,error}）。
// 自包含：假 RouterService + 真实 http，不依赖真实 daemon/守卫/账号数据。
// 同一闸的「纯判据 + 行为」双采样只留一条有区分度的纯判据（text/plain 拒 / 合法通过）。

const http = require('node:http');
const path = require('node:path');
// 步骤4：dispatcher 上移 L0（src/platform/ctl/server.js）。白名单改为**必填按域注入**，
// 故测试自备一份与生产 router 表同形的最小白名单（只含本文件用到的方法）。
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

// 假 RouterService：覆盖同步/异步/参数/异常四类方法
function fakeRouter() {
  return {
    _calls: [],
    status() { return { running: true, mode: 'daemon' }; },
    addProxyKey(id, key) { this._calls.push(['addProxyKey', id, key]); return { ok: true }; },
    async listProviders() { return { providers: [{ id: 'p1' }] }; },
    //  测试替身必须复用**白名单内**的方法名来验证"异步/异常"语义（任意方法名会被白名单
    //  正确拒绝，那是设计意图而非缺陷）：异步多参 -> refreshProviderQuota；异常 -> removeProvider。
    async refreshProviderQuota(id, deep) { await new Promise((r) => setTimeout(r, 20)); return { id, deep }; },
    removeProvider(id) { if (!id) throw new Error('boom'); return { ok: true, removed: id }; },
    // 显式保留一个**不在白名单**的方法，用于断言"内部/未登记方法不可达"。
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
  //  安全面（PG-5）：白名单缺省必须**拒绝启动**（fail-closed），不得回退到放行/借用他域表。
  let threw = false;
  try { createCtlServer({ target: router }); } catch { threw = true; }
  check('PG-5 未注入 allowMethods → 拒绝启动（fail-closed）', threw);
  check('PG-5 isMethodAllowed 判据：登记可达 / 内部方法不可达',
    isMethodAllowed(WHITELIST, 'status') === true && isMethodAllowed(WHITELIST, '_save') === false
    && isMethodAllowed(WHITELIST, 'eventsTail') === true && isMethodAllowed(WHITELIST, 'noSuchMethod') === false);
  const server = createCtlServer({ target: router, allowMethods: WHITELIST });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;

  // 1. health
  const h = await ctlGet(port, '/health');
  check('GET /health ok', h.code === 200 && h.json.ok === true, h);

  // 2. 同步方法 + 参数透传（同一响应体的两面：ok 与按序透传）
  const r1 = await ctlPost(port, { method: 'addProxyKey', args: ['prov-1', 'sk-xxx'] });
  check('同步方法 ok:true 且参数按序透传', r1.code === 200 && r1.json.ok === true
    && JSON.stringify(router._calls[0]) === JSON.stringify(['addProxyKey', 'prov-1', 'sk-xxx']), router._calls);

  // 3. 异步方法（单参/多参两条桩管道合成 1 条）
  const r2 = await ctlPost(port, { method: 'listProviders' });
  const r3 = await ctlPost(port, { method: 'refreshProviderQuota', args: ['p1', true] });
  check('异步方法正确返回、多参正确透传',
    r2.json.ok === true && r2.json.value.providers.length === 1 && r3.json.ok === true && r3.json.value.deep === true && r3.json.value.id === 'p1', r3.json);

  // 5. 未知方法
  const r4 = await ctlPost(port, { method: 'noSuchMethod', args: [] });
  check('未知方法返回 404', r4.code === 404 && r4.json.ok === false, r4);

  // 6. 方法抛错 -> ok:false + error（业务层语义：守卫据此返回 4xx）
  const r5 = await ctlPost(port, { method: 'removeProvider', args: [] }); // 触发内部 throw
  check('方法异常 → ok:false error=boom', r5.json.ok === false && r5.json.error === 'boom', r5.json);

  // 6b.  白名单闸（PG-5）：未登记方法一律拒绝，内部方法（_ 前缀）永不可达。
  //     `_internalSecret` 在替身上真实存在 -> 404 只能来自前缀闸（不是「方法不存在」的巧合）。
  const r6 = await ctlPost(port, { method: '_internalSecret', args: [] });
  const r7 = await ctlPost(port, { method: '_save', args: [] });
  check('PG-5 未登记/内部方法被拒绝（白名单闸：_internalSecret 与 _save 均 404）',
    r6.code === 404 && r6.json.ok === false && r7.code === 404 && r7.json.ok === false, r6.json);

  // 7. 非法 JSON
  const bad = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/ctl', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': 5 } }, (res) => {
      let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ code: res.statusCode, json: JSON.parse(b) }));
    });
    req.on('error', reject);
    req.end('{oops');
  });
  check('非法 JSON → 400', bad.code === 400, bad);

  // 7b.  来源闸（AUDIT B-2）：application/json 必需 + Origin 若携带必须回环。
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
