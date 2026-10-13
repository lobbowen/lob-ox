const install = require('C:/work/lob-ox/core/src/domains/agent/ops/install.js');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const assert = require('node:assert');
let pass = 0; const fails = [];
function check(n, f) { try { f(); pass++; } catch (e) { fails.push(n + ': ' + e.message); } }

// 假 dist：记录收到的入参，可模拟成功/失败
function fakeDist(behavior) {
  const calls = [];
  return {
    calls,
    async runNpmInstall(o) { calls.push(o); return behavior.install ? behavior.install(o) : { ok: true }; },
    async fetchNpmLatest(pkg) { calls.push({ fetchNpmLatest: pkg }); return behavior.latest || { ok: true, version: '9.9.9', origin: 'https://reg.example' }; },
  };
}

check('installToPrefix 缺 pkg 明确报错（不猜包名）', async () => {
  const r = await install.installToPrefix({ prefix: '/tmp/x', dist: fakeDist({}) });
  assert.strictEqual(r.ok, false);
  assert.ok(/包名/.test(r.error), '错误应指出缺包名: ' + r.error);
});

check('installToPrefix 缺 prefix 明确报错', async () => {
  const r = await install.installToPrefix({ product: { pkg: '@lob-ox/dsh' }, dist: fakeDist({}) });
  assert.strictEqual(r.ok, false);
  assert.ok(/前缀/.test(r.error));
});

check('installToPrefix 缺 dist 明确报错', async () => {
  const r = await install.installToPrefix({ product: { pkg: '@lob-ox/dsh' }, prefix: '/tmp/x' });
  assert.strictEqual(r.ok, false);
  assert.ok(/dist/.test(r.error));
});

check('installToPrefix 把 pkg/version/prefix/registry 透传给 dist', async () => {
  const d = fakeDist({});
  const r = await install.installToPrefix({
    product: { pkg: '@lob-ox/dsh' },
    prefix: '/tmp/somewhere',
    version: '1.2.3',
    registry: 'https://reg.example',
    dist: d,
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.version, '1.2.3');
  const call = d.calls[0];
  assert.strictEqual(call.pkg, '@lob-ox/dsh');
  assert.strictEqual(call.version, '1.2.3');
  assert.strictEqual(call.prefix, '/tmp/somewhere');
  assert.strictEqual(call.registry, 'https://reg.example');
});

check('形态无关：沙箱 prefix 与原生 prefix 走同一条路径', async () => {
  const d1 = fakeDist({});
  await install.installToPrefix({ product: { pkg: '@lob-ox/dsh' }, prefix: '/tmp/agents/a1/install', dist: d1 });
  const d2 = fakeDist({});
  await install.installToPrefix({ product: { pkg: '@lob-ox/dsh' }, prefix: '/usr/local/lib', dist: d2 });
  // 两次调用的形态完全一致，只有 prefix 不同
  assert.deepStrictEqual(Object.keys(d1.calls[0]).sort(), Object.keys(d2.calls[0]).sort());
  assert.notStrictEqual(d1.calls[0].prefix, d2.calls[0].prefix);
});

check('dist 安装失败时如实回传 error', async () => {
  const d = fakeDist({ install: () => ({ ok: false, error: 'npm ETARGET' }) });
  const r = await install.installToPrefix({ product: { pkg: '@lob-ox/dsh' }, prefix: '/tmp/x', dist: d });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, 'npm ETARGET');
});

check('onLine 逐行回调 + 日志过滤噪声', async () => {
  const seen = [];
  const d = fakeDist({ install: (o) => { o.onLine('npm warn deprecated foo'); o.onLine('real output'); o.onLine('npm notice stuff'); return { ok: true }; } });
  const r = await install.installToPrefix({ product: { pkg: '@lob-ox/dsh' }, prefix: '/tmp/x', dist: d, onLine: (l) => seen.push(l) });
  assert.strictEqual(r.ok, true);
  assert.ok(seen.includes('real output'), '真实输出应透出');
  assert.ok(!seen.some(l => /npm warn/.test(l)), 'npm warn 应被过滤');
  assert.ok(!seen.some(l => /npm notice/.test(l)), 'npm notice 应被过滤');
});

check('installedVersionAt 从 prefix 下读版本', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-inst-'));
  const pkgDir = path.join(dir, 'node_modules', '@lob-ox', 'dsh');
  fs.mkdirSync(pkgDir, { recursive: true });
  fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: '@lob-ox/dsh', version: '3.2.1' }));
  assert.strictEqual(install.installedVersionAt(dir, '@lob-ox/dsh'), '3.2.1');
  assert.strictEqual(install.installedVersionAt(dir, '@lob-ox/other'), null, '不存在的包返回 null');
  assert.strictEqual(install.installedVersionAt(null, '@lob-ox/dsh'), null, '缺 prefix 返回 null');
  fs.rmSync(dir, { recursive: true, force: true });
});

check('createLatestResolver 带 TTL 缓存', async () => {
  let n = 0;
  const d = { async fetchNpmLatest() { n++; return { ok: true, version: '1.0.' + n, origin: 'r' }; } };
  const latest = install.createLatestResolver(d, { ttlMs: 60000 });
  const a = await latest('@lob-ox/dsh');
  const b = await latest('@lob-ox/dsh');
  assert.strictEqual(a.version, b.version, 'TTL 内应命中缓存');
  assert.strictEqual(n, 1, '只应查询一次，实际 ' + n);
  const c = await latest('@lob-ox/other');
  assert.strictEqual(n, 2, '不同包名应重新查询');
});

check('createLatestResolver 缓存不缓存失败', async () => {
  let n = 0;
  const d = { async fetchNpmLatest() { n++; return { ok: false, version: null, error: 'net' }; } };
  const latest = install.createLatestResolver(d, { ttlMs: 60000 });
  await latest('@lob-ox/dsh');
  await latest('@lob-ox/dsh');
  assert.strictEqual(n, 2, '失败不应被缓存（下次要能重试）');
});

check('checkEnvironment 无 launcher 时明确报错', async () => {
  const r = await install.checkEnvironment(null);
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.length > 0);
});

check('checkEnvironment 探到 node/npm', async () => {
  const r = await install.checkEnvironment({ program: 'node', args: [] });
  assert.strictEqual(r.ok, true, 'node 自身可当 npm 探针: ' + JSON.stringify(r.errors));
});

setTimeout(() => {
  console.log('agent ops/install 测试: ' + pass + ' 通过, ' + fails.length + ' 失败');
  if (fails.length) { console.log(fails.map(f => '  x ' + f).join('\n')); process.exit(1); }
  console.log('ALL AGENT INSTALL TESTS PASS');
}, 800);