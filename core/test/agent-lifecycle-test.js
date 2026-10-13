const lc = require('C:/work/lob-ox/core/src/domains/agent/ops/lifecycle.js');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert');
let pass = 0; const fails = [];
function check(n, f) { try { f(); pass++; } catch (e) { fails.push(n + ': ' + e.message); } }
const ASYNC = [];
function acheck(n, f) { ASYNC.push([n, f]); }

check('envFor：原生不重定向', () => {
  const r = lc.envFor({ kind: 'native' }, { data: '/x' });
  assert.deepStrictEqual(r.env, {}, '原生应与壳同环境');
});
check('envFor：沙箱全量重定向', () => {
  const dirs = {
    data: path.join('var', 'agents', 'a1', 'data'),
    install: path.join('var', 'agents', 'a1', 'install'),
    nodeModules: path.join('var', 'agents', 'a1', 'install', 'lib', 'node_modules'),
    tmp: path.join('var', 'agents', 'a1', 'tmp'),
  };
  const r = lc.envFor({ kind: 'sandbox' }, dirs);
  assert.strictEqual(r.env.HOME, dirs.data);
  assert.strictEqual(r.env.USERPROFILE, dirs.data);
  assert.strictEqual(r.env.TMPDIR, dirs.tmp);
  assert.strictEqual(r.workingDir, dirs.data);
});
check('envFor：缺 dirs 不崩', () => {
  const r = lc.envFor({ kind: 'sandbox' }, {});
  assert.deepStrictEqual(r.env, {}, '缺 data 应返回空 env（不假装隔离生效）');
});

acheck('ready：端口无人听 → port-closed', async () => {
  // 绑定后立即关闭，拿到一个几乎必然无人听的端口
  const srv = http.createServer();
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  await new Promise(r => srv.close(r));
  const r = await lc.ready(port, { timeoutMs: 500 });
  assert.strictEqual(r.state, 'port-closed', JSON.stringify(r));
});

acheck('ready：/healthz 200 → ready', async () => {
  const srv = http.createServer((req, res) => {
    if (req.url === '/healthz') { res.writeHead(200); res.end('ok'); }
    else { res.writeHead(404); res.end(); }
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const r = await lc.ready(port, { timeoutMs: 1000 });
  assert.strictEqual(r.state, 'ready', JSON.stringify(r));
  await new Promise(r2 => srv.close(r2));
});

acheck('ready：503 → http 带状态码（不与 ready 混淆）', async () => {
  const srv = http.createServer((req, res) => { res.writeHead(503); res.end(); });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const r = await lc.ready(port, { timeoutMs: 1000 });
  assert.strictEqual(r.state, 'http', JSON.stringify(r));
  assert.strictEqual(r.status, 503);
  await new Promise(r2 => srv.close(r2));
});

acheck('ready：自定义 healthPath', async () => {
  const srv = http.createServer((req, res) => {
    if (req.url === '/health') { res.writeHead(200); res.end(); }
    else { res.writeHead(404); res.end(); }
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const r = await lc.ready(port, { timeoutMs: 1000, healthPath: '/health' });
  assert.strictEqual(r.state, 'ready');
  await new Promise(r2 => srv.close(r2));
});

acheck('start：缺 entry 明确报错', async () => {
  const r = await lc.start({ agent: { id: 'a1', kind: 'sandbox' }, entry: [] });
  assert.strictEqual(r.ok, false);
  assert.ok(/入口未定位/.test(r.error));
});

acheck('start：缺 service 明确报错', async () => {
  const r = await lc.start({ agent: { id: 'a1', kind: 'sandbox' }, entry: ['node', 'x.js'] });
  assert.strictEqual(r.ok, false);
  assert.ok(/startTransient/.test(r.error));
});

acheck('start：端口被占则拒绝（PORT_TAKEN）', async () => {
  let called = false;
  const r = await lc.start({
    agent: { id: 'a1', kind: 'sandbox' },
    entry: ['node', 'x.js'],
    port: 3000,
    ports: { recordOf: (p) => ({ owner: 'inst:other', role: 'proxyInstance' }) },
    service: { startTransient: async () => { called = true; } },
  });
  assert.strictEqual(r.ok, false);
  assert.ok(/PORT_TAKEN:inst:other/.test(r.error), r.error);
  assert.strictEqual(called, false, '端口被占不应拉起');
});

acheck('start：成功路径把 entry/env/unit 交给 service', async () => {
  let got = null;
  const dirs = {
    data: path.join('var', 'a1', 'data'),
    install: path.join('var', 'a1', 'install'),
    nodeModules: path.join('var', 'a1', 'nm'),
    tmp: path.join('var', 'a1', 'tmp'),
  };
  const r = await lc.start({
    agent: { id: 'a1', kind: 'sandbox' },
    entry: ['node', path.join('var', 'bin.js')],
    dirs,
    port: 3100,
    unit: 'dsh-web@a1',
    pidFile: path.join('var', 'a1', 'run.pid'),
    anchors: ['--port 3100'],
    service: { startTransient: async (spec) => { got = spec; } },
  });
  assert.strictEqual(r.ok, true, r.error);
  assert.strictEqual(got.unit, 'dsh-web@a1');
  assert.deepStrictEqual(got.cmd, ['node', path.join('var', 'bin.js')]);
  assert.strictEqual(got.env.HOME, dirs.data, '沙箱应传重定向后的 env');
  assert.strictEqual(got.port, 3100);
  assert.deepStrictEqual(got.anchors, ['--port 3100']);
});

acheck('start：原生不重定向 env', async () => {
  let got = null;
  await lc.start({
    agent: { id: 'a2', kind: 'native' },
    entry: ['dsh'],
    service: { startTransient: async (spec) => { got = spec; } },
  });
  assert.deepStrictEqual(got.env, {}, '原生 env 应为空（不重定向）');
});

acheck('stop：service 返回 false 即失败', async () => {
  const r = await lc.stop({
    agent: { id: 'a1' },
    service: { stopUnit: async () => false },
  });
  assert.strictEqual(r.ok, false);
  assert.ok(/未确认停止/.test(r.error));
});

acheck('stop：成功路径', async () => {
  let gotUnit = null;
  const r = await lc.stop({
    agent: { id: 'a1' },
    unit: 'dsh-web@a1',
    service: { stopUnit: async (u, o) => { gotUnit = u; return true; } },
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(gotUnit, 'dsh-web@a1');
});

acheck('stop：缺 stopUnit 明确报错', async () => {
  const r = await lc.stop({ agent: { id: 'a1' }, service: {} });
  assert.strictEqual(r.ok, false);
  assert.ok(/stopUnit/.test(r.error));
});

(async () => {
  for (const [n, f] of ASYNC) {
    try { await f(); pass++; } catch (e) { fails.push(n + ': ' + e.message); }
  }
  console.log('agent ops/lifecycle 测试: ' + pass + ' 通过, ' + fails.length + ' 失败');
  if (fails.length) { console.log(fails.map(f => '  x ' + f).join('\n')); process.exit(1); }
  console.log('ALL AGENT LIFECYCLE TESTS PASS');
})();