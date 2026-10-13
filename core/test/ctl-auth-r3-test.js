'use strict';
// R3 / 攻击链 A：ctl 面机箱令牌鉴权。
const assert = require('node:assert');
const http = require('node:http');
const { createCtlServer } = require('C:/work/lob-ox/core/src/platform/ctl/server.js');

const TOKEN = 'test-secret-token-12345';
process.env.DSH_CTL_TOKEN = TOKEN;

let passed = 0;
const failures = [];
function check(n, f) { try { f(); passed++; } catch (e) { failures.push(n + ': ' + e.message); } }

const target = { echo: (x) => ({ got: x }) };
const server = createCtlServer({ target, allowMethods: ['echo'], logger: { warn: () => {} } });

function call(headers, method, args) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ method: method || 'echo', args: args || ['hi'] });
    const h = Object.assign({ 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, headers || {});
    const req = http.request({ host: '127.0.0.1', port: server.address().port, path: '/ctl', method: 'POST', headers: h },
      (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ code: res.statusCode, body: b })); });
    req.on('error', reject); req.end(body);
  });
}
function get(path) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: server.address().port, path, method: 'GET' },
      (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ code: res.statusCode, body: b })); });
    req.on('error', reject); req.end();
  });
}

server.listen(0, '127.0.0.1', async () => {
  const TOKH = { 'x-lobox-ctl-token': TOKEN };

  // 1. 无 token 头 → 401（此前可直连，是本缺陷的核心）
  check('无 token 头返回 401', async () => {
    const r = await call({});
    assert.strictEqual(r.code, 401, '应 401，实际 ' + r.code);
  });

  // 2. 错误 token → 401
  check('错误 token 返回 401', async () => {
    const r = await call({ 'x-lobox-ctl-token': 'wrong-token-value' });
    assert.strictEqual(r.code, 401, '应 401，实际 ' + r.code);
  });

  // 3. 前缀相近的 token → 401（常量时间比较，不因前缀匹配放行）
  check('前缀相近 token 仍 401', async () => {
    const r = await call({ 'x-lobox-ctl-token': TOKEN.slice(0, TOKEN.length - 1) });
    assert.strictEqual(r.code, 401, '应 401，实际 ' + r.code);
  });

  // 4. 正确 token → 200 且业务可用
  check('正确 token 放行且业务可用', async () => {
    const r = await call(TOKH);
    assert.strictEqual(r.code, 200, '应 200，实际 ' + r.code + ' body=' + r.body);
    const j = JSON.parse(r.body);
    assert.strictEqual(j.ok, true);
    assert.deepStrictEqual(j.value, { got: 'hi' });
  });

  // 5. 白名单不因鉴权通过而放宽
  check('未白名单方法仍被拒', async () => {
    const r = await call(TOKH, 'rm-rf-everything', []);
    assert.strictEqual(r.code, 404, '未白名单方法应 404，实际 ' + r.code);
    assert.ok(/method not allowed/.test(r.body), 'body 应说明 method not allowed: ' + r.body);
  });

  // 6. /health 探活不需 token（否则壳无法判断 daemon 存活）
  check('/health 无需 token', async () => {
    const r = await get('/health');
    assert.strictEqual(r.code, 200, '应 200，实际 ' + r.code);
  });

  setTimeout(() => {
    console.log('R3 ctl 鉴权测试：' + passed + ' 通过，' + failures.length + ' 失败');
    if (failures.length) { console.log(failures.map((f) => '  x ' + f).join('\n')); process.exit(1); }
    console.log('ALL R3 CTL AUTH TESTS PASS');
    server.close();
  }, 400);
});
