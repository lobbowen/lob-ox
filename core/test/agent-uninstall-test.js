const { uninstall, withinAncestor } = require('C:/work/lob-ox/core/src/domains/agent/ops/uninstall.js');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const assert = require('node:assert');
let pass = 0; const fails = [];
function check(n, f) { try { f(); pass++; } catch (e) { fails.push(n + ': ' + e.message); } }
const BS = String.fromCharCode(92);

// 路径一律用 path.join 构造：POSIX 字面量在 Windows 上不是绝对路径，
// withinAncestor 的 resolve 归一化会把它变成 CWD 相对路径，断言就全歪了。
const A = path.join('a');
const AB = path.join('a', 'b');
const ABC = path.join('a', 'b', 'c');
const X = path.join('x');
const XY = path.join('x', 'y');
const ABC2 = path.join('a', 'bc');
check('withinAncestor：同目录算在内', () => {
  assert.strictEqual(withinAncestor(AB, [AB]), true);
  assert.strictEqual(withinAncestor(ABC, [AB]), true);
});
check('withinAncestor：外部路径拒绝', () => {
  assert.strictEqual(withinAncestor(AB, [A]), true, 'AB 确实在 A 下（子目录）');
  assert.strictEqual(withinAncestor(XY, [AB]), false);
  assert.strictEqual(withinAncestor(ABC2, [AB]), false, '前缀相同但非子目录（bc vs b/）');
});
check('withinAncestor：Windows 盘符路径', () => {
  const root = 'C:' + BS + 'Users' + BS + 'x' + BS + 'lobox';
  const inside = root + BS + 'agents' + BS + 'a1';
  const outside = 'C:' + BS + 'Users' + BS + 'x' + BS + 'other';
  assert.strictEqual(withinAncestor(inside, [root]), true);
  assert.strictEqual(withinAncestor(outside, [root]), false);
});
check('withinAncestor：空/异常输入不抛', () => {
  assert.strictEqual(withinAncestor(null, ['/a']), false);
  assert.strictEqual(withinAncestor('/a', null), false);
  assert.strictEqual(withinAncestor('/a', []), false);
  assert.strictEqual(withinAncestor('/a', [null, undefined]), false);
});

// 以下为异步用例
const ASYNC = [];
function acheck(n, f) { ASYNC.push([n, f]); }

acheck('缺 safeAncestors 拒绝卸载（安全边界不可缺省）', async () => {
  const r = await uninstall({});
  assert.strictEqual(r.ok, false);
  assert.ok(/safeAncestors/.test(r.error), '错误应指出缺安全边界: ' + r.error);
  assert.deepStrictEqual(r.removed, []);
});

acheck('busy 时拒绝卸载', async () => {
  const r = await uninstall({ safeAncestors: ['/tmp'], state: { upgradeState: 'installing' } });
  assert.strictEqual(r.ok, false);
  assert.ok(/进行中/.test(r.error), '错误应说明忙碌: ' + r.error);
});

acheck('越界路径被跳过并留痕，不删', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-unin-'));
  const inside = path.join(root, 'agents', 'a1');
  // 用 mkdtemp 保证唯一：固定名 + Date.now() 在同一毫秒内多次运行会撞目录，
  // 读到上一次的残留文件，断言就假失败。
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-unin-outside-'));
  fs.mkdirSync(inside, { recursive: true });
  fs.writeFileSync(path.join(inside, 'marker'), 'x');
  fs.writeFileSync(path.join(outside, 'marker'), 'x');
  const logs = [];
  const r = await uninstall({
    safeAncestors: [root],
    extraPaths: [inside, outside],
    log: (m) => logs.push(m),
  });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.removed, [inside], '只应删界内路径');
  assert.ok(fs.existsSync(path.join(outside, 'marker')), '界外文件必须还在（未被误删）');
  assert.ok(logs.some(l => /越界/.test(l)), '应留痕说明跳过');
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

acheck('前缀自身在界内则被删', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-unin2-'));
  const prefix = path.join(root, 'install');
  fs.mkdirSync(prefix, { recursive: true });
  const r = await uninstall({ safeAncestors: [root], prefix });
  assert.strictEqual(r.ok, true);
  assert.ok(r.removed.includes(prefix));
  assert.ok(!fs.existsSync(prefix), '前缀应被删');
  fs.rmSync(root, { recursive: true, force: true });
});

acheck('进程在跑则先停', async () => {
  let stopped = false;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-unin3-'));
  const r = await uninstall({
    safeAncestors: [root],
    isActive: () => true,
    stop: async () => { stopped = true; },
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(stopped, true, '应先停进程再清理');
  fs.rmSync(root, { recursive: true, force: true });
});

acheck('runNpm 失败不阻断本地清理', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-unin4-'));
  const extra = path.join(root, 'data');
  fs.mkdirSync(extra, { recursive: true });
  const r = await uninstall({
    safeAncestors: [root],
    extraPaths: [extra],
    pkg: '@lob-ox/dsh',
    runNpm: async () => ({ ok: false, error: 'npm E404' }),
  });
  assert.strictEqual(r.ok, true, 'npm 失败不阻断: ' + r.error);
  assert.ok(r.removed.includes(extra), '本地数据仍应清理');
  fs.rmSync(root, { recursive: true, force: true });
});

acheck('事件与状态流转', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-unin5-'));
  const evs = [];
  const state = { upgradeState: 'idle' };
  await uninstall({
    safeAncestors: [root],
    events: { append: (t) => evs.push(t) },
    state,
  });
  assert.ok(evs.includes('agent_uninstall_started'));
  assert.ok(evs.includes('agent_uninstalled'));
  assert.strictEqual(state.uninstalling, null, '结束后应清忙碌标记');
  fs.rmSync(root, { recursive: true, force: true });
});

(async () => {
  for (const [n, f] of ASYNC) {
    try { await f(); pass++; } catch (e) { fails.push(n + ': ' + e.message); }
  }
  console.log('agent ops/uninstall 测试: ' + pass + ' 通过, ' + fails.length + ' 失败');
  if (fails.length) { console.log(fails.map(f => '  x ' + f).join('\n')); process.exit(1); }
  console.log('ALL AGENT UNINSTALL TESTS PASS');
})();