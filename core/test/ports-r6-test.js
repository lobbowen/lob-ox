'use strict';
// R6 行为测试：端口账本的跨进程联合避让。
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { PortRegistry } = require('C:/work/lob-ox/core/src/platform/service/ports/pool.js');

let passed = 0;
const failures = [];
function check(n, f) { try { f(); passed++; } catch (e) { failures.push(n + ': ' + e.message); } }

function mkTmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'r6test-')); }

// 1. sibling 登记后，联合避让集合含双方记录
check('联合避让集合含 sibling 记录', () => {
  const dir = mkTmp();
  const guardF = path.join(dir, 'ports.json');
  const routerF = path.join(dir, 'ports-router.json');
  // 预置两份账本
  fs.writeFileSync(guardF, JSON.stringify({ records: [{ port: 21000, role: 'proxyInstance', owner: 'proxy:a', createdAt: 1 }] }));
  fs.writeFileSync(routerF, JSON.stringify({ records: [{ port: 21001, role: 'proxyInstance', owner: 'proxy:b', createdAt: 1 }] }));
  // guard 侧：router 是 sibling
  const g = new PortRegistry({ file: guardF });
  g.configureFile(guardF, { siblingFiles: [routerF] });
  const joint = g._foreignPorts();
  assert.ok(joint.has(21000), '应含本方记录');
  assert.ok(joint.has(21001), '应含 sibling 记录');
  // router 侧：guard 是 sibling
  const r = new PortRegistry({ file: routerF });
  r.configureFile(routerF, { siblingFiles: [guardF] });
  const joint2 = r._foreignPorts();
  assert.ok(joint2.has(21000), 'router 侧应看到 guard 的记录');
  assert.ok(joint2.has(21001), 'router 侧应含本方记录');
  fs.rmSync(dir, { recursive: true, force: true });
});

// 2. _allocFreeCore 不分配 sibling 已占用的端口（核心不变量）
check('分配避开 sibling 已占用端口', async () => {
  const dir = mkTmp();
  const guardF = path.join(dir, 'ports.json');
  const routerF = path.join(dir, 'ports-router.json');
  // sibling 占用 21000-21009 一整段
  const recs = [];
  for (let i = 0; i < 10; i++) recs.push({ port: 21000 + i, role: 'proxyInstance', owner: 'proxy:x', createdAt: 1 });
  fs.writeFileSync(routerF, JSON.stringify({ records: recs }));
  fs.writeFileSync(guardF, JSON.stringify({ records: [] }));
  const g = new PortRegistry({ file: guardF });
  g.configureFile(guardF, { siblingFiles: [routerF] });
  const alloc = g._alloc;
  const range = { base: 21000, count: 20 };
  const got = await alloc._allocFreeCore('proxyInstance', range, 'proxy:me', {});
  assert.ok(got && got.port, '应分配到端口');
  assert.ok(got.port >= 21010, '应跳过 sibling 占用的 21000-21009，实际 ' + got.port);
  fs.rmSync(dir, { recursive: true, force: true });
});

// 3. _tryClaim 对 sibling 已占用的 preferred 端口返回 null
check('tryClaim 拒绝 sibling 占用的 preferred', async () => {
  const dir = mkTmp();
  const guardF = path.join(dir, 'ports.json');
  const routerF = path.join(dir, 'ports-router.json');
  fs.writeFileSync(routerF, JSON.stringify({ records: [{ port: 21500, role: 'proxyInstance', owner: 'proxy:other', createdAt: 1 }] }));
  fs.writeFileSync(guardF, JSON.stringify({ records: [] }));
  const g = new PortRegistry({ file: guardF });
  g.configureFile(guardF, { siblingFiles: [routerF] });
  const got = await g._alloc._tryClaim(21500, 'proxy:me', 'proxyInstance', {});
  assert.strictEqual(got, null, 'sibling 已占用的 preferred 端口应被拒');
  fs.rmSync(dir, { recursive: true, force: true });
});

// 4. mtime 缓存：sibling 未变不重复读；变了能看见
check('sibling 缓存按 mtime 失效', () => {
  const dir = mkTmp();
  const guardF = path.join(dir, 'ports.json');
  const routerF = path.join(dir, 'ports-router.json');
  fs.writeFileSync(routerF, JSON.stringify({ records: [{ port: 22000, role: 'x', owner: 'o', createdAt: 1 }] }));
  fs.writeFileSync(guardF, JSON.stringify({ records: [] }));
  const g = new PortRegistry({ file: guardF });
  g.configureFile(guardF, { siblingFiles: [routerF] });
  assert.ok(g._foreignPorts().has(22000));
  // 改 sibling 内容（mtime 变）
  const st = fs.statSync(routerF);
  fs.writeFileSync(routerF, JSON.stringify({ records: [{ port: 22000, role: 'x', owner: 'o', createdAt: 1 }, { port: 22001, role: 'x', owner: 'o2', createdAt: 2 }] }));
  // 强制 mtime 变化（某些文件系统秒级精度）
  const future = new Date(st.mtimeMs + 2000);
  fs.utimesSync(routerF, future, future);
  const after = g._foreignPorts();
  assert.ok(after.has(22001), 'sibling 变更后应能看到新记录');
  fs.rmSync(dir, { recursive: true, force: true });
});

// 5. 无 sibling 时行为不回退（兼容单进程）
check('无 sibling 时只用本方记录', () => {
  const dir = mkTmp();
  const guardF = path.join(dir, 'ports.json');
  fs.writeFileSync(guardF, JSON.stringify({ records: [{ port: 23000, role: 'x', owner: 'o', createdAt: 1 }] }));
  const g = new PortRegistry({ file: guardF });
  const joint = g._foreignPorts();
  assert.ok(joint.has(23000), '应含本方记录');
  assert.strictEqual(joint.size, 1, '不应有其他记录');
  fs.rmSync(dir, { recursive: true, force: true });
});

// 6. sibling 文件不存在时不抛错
check('sibling 不存在不抛错', () => {
  const dir = mkTmp();
  const guardF = path.join(dir, 'ports.json');
  fs.writeFileSync(guardF, JSON.stringify({ records: [] }));
  const g = new PortRegistry({ file: guardF });
  g.configureFile(guardF, { siblingFiles: [path.join(dir, 'nonexistent.json')] });
  const joint = g._foreignPorts();
  assert.strictEqual(joint.size, 0, '不存在的 sibling 应被忽略');
  fs.rmSync(dir, { recursive: true, force: true });
});

// 7. configureFile 换文件时清掉指向旧文件的 sibling
check('configureFile 清掉自引用 sibling', () => {
  const dir = mkTmp();
  const f1 = path.join(dir, 'ports.json');
  const f2 = path.join(dir, 'ports-router.json');
  fs.writeFileSync(f1, JSON.stringify({ records: [] }));
  fs.writeFileSync(f2, JSON.stringify({ records: [] }));
  const g = new PortRegistry({ file: f1 });
  g.configureFile(f1, { siblingFiles: [f2] });
  assert.deepStrictEqual(g._foreign, [f2]);
  // 切到 f2，并声明 f1 为 sibling
  g.configureFile(f2, { siblingFiles: [f1] });
  assert.deepStrictEqual(g._foreign, [f1], '切文件后 sibling 应更新');
  fs.rmSync(dir, { recursive: true, force: true });
});

setTimeout(() => {
  console.log('R6 端口联合避让测试：' + passed + ' 通过，' + failures.length + ' 失败');
  if (failures.length) { console.log(failures.map((f) => '  x ' + f).join('\n')); process.exit(1); }
  console.log('ALL R6 PORT JOINT-AVOIDANCE TESTS PASS');
}, 3000);
// 8. mutator 持锁：_mutate 可重入（alloc 路径内联调用不死锁）
check('_mutate 可重入', () => {
  const dir = mkTmp();
  const f = path.join(dir, 'ports.json');
  fs.writeFileSync(f, JSON.stringify({ records: [] }));
  const g = new PortRegistry({ file: f });
  // 模拟已在锁内
  g._allocLock = true;
  const r = g._mutate(() => 'ok');
  assert.strictEqual(r, 'ok', '已持锁时应直接执行不重入');
  g._allocLock = false;
  fs.rmSync(dir, { recursive: true, force: true });
});

// 9. 五个 mutator 都能正常工作（加锁后功能不回退）
check('五个 mutator 功能正常', () => {
  const dir = mkTmp();
  const f = path.join(dir, 'ports.json');
  fs.writeFileSync(f, JSON.stringify({ records: [] }));
  const g = new PortRegistry({ file: f });
  g.register('dsh-main', 3080);
  assert.ok(g.isRegistered(3080), 'register 应生效');
  g.registerUser(25000, 'inst:1');
  assert.strictEqual(g.byOwner('inst:1'), 25000, 'registerUser 应生效');
  g.allocateMark(25100, 'providerApi', 'providerApi:p1');
  assert.ok(g.isRegistered(25100), 'allocateMark 应生效');
  g.release(25000, 'inst:1');
  assert.ok(!g.isRegistered(25000), 'release 应生效');
  g.unregister('providerApi:p1');
  assert.ok(!g.isRegistered(25100), 'unregister 应生效');
  fs.rmSync(dir, { recursive: true, force: true });
});

// 10. registerSole 原子性：同 role 旧记录被替换
check('registerSole 替换同 role 旧记录', () => {
  const dir = mkTmp();
  const f = path.join(dir, 'ports.json');
  fs.writeFileSync(f, JSON.stringify({ records: [] }));
  const g = new PortRegistry({ file: f });
  g.registerSole('supervisor-api', 37360);
  assert.strictEqual(g.get('supervisor-api'), 37360);
  g.registerSole('supervisor-api', 37361);
  assert.strictEqual(g.get('supervisor-api'), 37361, '应指向新端口');
  assert.ok(!g.isRegistered(37360), '旧端口应被删除');
  fs.rmSync(dir, { recursive: true, force: true });
});