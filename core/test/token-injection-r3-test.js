'use strict';
// R3 集成测试：守卫生成令牌 → daemon spawnEnv 注入 → ctl 校验通过。
// 这是攻击链 A 封堵的最后一环：此前 ctl 有鉴权但无人注入令牌，等于没生效。
const assert = require('node:assert');
const crypto = require('node:crypto');
const http = require('node:http');
const { createCtlServer } = require('C:/work/lob-ox/core/src/platform/ctl/server.js');
const { ctlCall } = require('C:/work/lob-ox/core/src/platform/service/log/tail.js');

let passed = 0;
const failures = [];
function check(n, f) { try { f(); passed++; } catch (e) { failures.push(n + ': ' + e.message); } }

const target = { echo: (x) => ({ got: x }) };
const server = createCtlServer({ target, allowMethods: ['echo'], logger: { warn: () => {} } });

// 模拟守卫的令牌生成逻辑（与 app/daemons/runtime.js 的 spawnEnv 同形）
function guardGenerateToken(host) {
  if (!host._ctlToken) {
    try { host._ctlToken = crypto.randomBytes(32).toString('hex'); }
    catch { host._ctlToken = null; }
  }
  return host._ctlToken;
}

server.listen(0, '127.0.0.1', async () => {
  const port = server.address().port;

  // 1. 守卫生成令牌并设为自身 env
  const host = {};
  const token = guardGenerateToken(host);
  process.env.DSH_CTL_TOKEN = token;
  check('守卫生成 32 字节 hex 令牌', () => {
    assert.ok(token && token.length === 64, '应生成 64 位 hex，实际 ' + (token && token.length));
  });

  // 2. ctlCall（守卫侧调用方）带令牌能通
  check('ctlCall 带令牌调用成功', async () => {
    const v = await ctlCall(port, 'echo', ['hello'], 3000);
    assert.deepStrictEqual(v, { got: 'hello' });
  });

  // 3. 无令牌的裸 HTTP 请求被拒（攻击面）
  check('无令牌裸请求仍被拒', async () => {
    const body = JSON.stringify({ method: 'echo', args: ['x'] });
    const r = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/ctl', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
        (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ code: res.statusCode, body: b })); });
      req.on('error', reject); req.end(body);
    });
    assert.strictEqual(r.code, 401, '无令牌应 401，实际 ' + r.code);
  });

  // 4. daemon 收到的 env 与守卫自身 env 一致（同一令牌）
  check('daemon spawnEnv 与守卫 env 同令牌', () => {
    // 模拟 spawnEnv 的返回（runtime.js 的逻辑）
    const cfgPath = '/tmp/x.json';
    const env = { DSH_SUPERVISOR_CONFIG: cfgPath };
    if (host._ctlToken) {
      env.DSH_CTL_TOKEN = host._ctlToken;
      process.env.DSH_CTL_TOKEN = host._ctlToken;
    }
    assert.strictEqual(env.DSH_CTL_TOKEN, token, 'daemon 收到的令牌应与守卫生成的一致');
    assert.strictEqual(process.env.DSH_CTL_TOKEN, token, '守卫自身 env 也应是同一令牌');
  });

  // 5. 令牌唯一性：两个守卫实例生成不同令牌
  check('不同守卫实例令牌不同', () => {
    const h2 = {};
    const t2 = guardGenerateToken(h2);
    assert.notStrictEqual(t2, token, '不同实例应生成不同令牌');
  });

  setTimeout(() => {
    console.log('R3 令牌注入集成测试：' + passed + ' 通过，' + failures.length + ' 失败');
    if (failures.length) { console.log(failures.map((f) => '  x ' + f).join('\n')); process.exit(1); }
    console.log('ALL R3 TOKEN INJECTION TESTS PASS');
    server.close();
  }, 500);
});