#!/usr/bin/env node
'use strict';


const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ports-capacity-'));
const results = [];
const skipped = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined ? '  ← ' + x : '')); };
// 环境不具备验证条件时必须 SKIP，不得让判据恒真后计入 PASS（非 Linux 无 /proc ⇒ overlaps 恒 false，曾伪装成通过）。
const skip = (n, why) => { skipped.push(n); console.log('SKIP ' + n + (why ? '  ← ' + why : '')); };

(async () => {
  const { PortRegistry, DEFAULT_POOLS, SEGMENT_POOL } = require(path.join(ROOT, 'src', 'platform', 'service', 'ports'));
  // 段名/独立池是域知识，由测试显式申报（生产由 router/relay 域装配期注入；未申报段回退 managed）。
  require(path.join(ROOT, 'src', 'domains', 'router', 'port-segments'));
  require(path.join(ROOT, 'src', 'domains', 'relay', 'port-segments'));

  console.log('== 1) 池选址（RFC 6335 / 避开 OS ephemeral）==');
  const ephemeral = (() => {
    try {
      const raw = fs.readFileSync('/proc/sys/net/ipv4/ip_local_port_range', 'utf8').trim().split(/\s+/);
      const lo = Number(raw[0]), hi = Number(raw[1]);
      return (Number.isInteger(lo) && Number.isInteger(hi)) ? { lo, hi } : null;
    } catch { return null; }
  })();
  // 合法区间(1024-65535)任何平台都能验 ⇒ 永远真检；
  // 「避开 OS 动态端口范围」只有读到 /proc 才能验 ⇒ 读不到就 SKIP（此前写成恒真，非 Linux 上等于没验）。
  check('默认池落在合法端口区间(1024-65535)',
    Object.values(DEFAULT_POOLS).every((p) => p.base >= 1024 && p.base + p.count - 1 <= 65535),
    'pools=' + JSON.stringify(DEFAULT_POOLS));
  if (ephemeral) {
    const overlaps = (p) => !(p.base + p.count - 1 < ephemeral.lo || p.base > ephemeral.hi);
    check('默认池避开 OS 动态端口范围', !Object.values(DEFAULT_POOLS).some(overlaps),
      'ephemeral=' + ephemeral.lo + '-' + ephemeral.hi + ' pools=' + JSON.stringify(DEFAULT_POOLS));
  } else {
    skip('默认池避开 OS 动态端口范围', '无 /proc/sys/net/ipv4/ip_local_port_range（非 Linux）⇒ 无法比对');
  }

  console.log('== 2) 供应商规模弹性（旧固定 32 上限）==');
  const reg = new PortRegistry({ file: path.join(TMP, 'ports.json') });
  const N = 200;
  const portsGot = [];
  for (let i = 0; i < N; i++) portsGot.push(await reg.allocate('providerApi', 'providerApi:prov-' + i));
  check('providerApi 连续分配 ' + N + ' 个成功且互不重复',
    portsGot.every((p) => Number.isInteger(p) && p > 0) && new Set(portsGot).size === N,
    'got=' + portsGot.filter(Boolean).length);
  const cap = reg.capacity();
  check('capacity()/available()/isFull() 反映真实用量',
    cap.providerApi.used === N && cap.providerApi.free === cap.providerApi.size - N
      && reg.available('providerApi') === cap.providerApi.free && reg.isFull('providerApi') === false, JSON.stringify(cap.providerApi));

  console.log('== 3) 共享池（K8s 单一范围思想）==');
  const rp = await reg.allocate('relay', 'relay:a');
  const pp = await reg.allocate('proxyInstance', 'proxy:b');
  const op = await reg.allocate('oauthCallback', 'oauth:c');
  check('三段锚点不同（确定性起点）', rp !== pp && pp !== op && rp !== op, JSON.stringify({ rp, pp, op }));
  check('relay/proxyInstance/oauthCallback 同池（声明一致 + 分配不互相覆盖）',
    SEGMENT_POOL.relay === SEGMENT_POOL.proxyInstance && SEGMENT_POOL.proxyInstance === SEGMENT_POOL.oauthCallback
      && [rp, pp, op].every((p) => p >= DEFAULT_POOLS.managed.base && p < DEFAULT_POOLS.managed.base + DEFAULT_POOLS.managed.count));

  console.log('== 4) 池满显式错误 ==');
  const small = new PortRegistry({ file: path.join(TMP, 'small.json'), pools: Object.assign({}, DEFAULT_POOLS, { providerApi: { base: 27000, count: 4 } }) });
  for (let i = 0; i < 4; i++) await small.allocate('providerApi', 's' + i);
  const full = await small.claimSlot('providerApi', 'overflow');
  check('池满 claimSlot 返回显式 conflict/ErrFull + capacity 可观测 + isFull() 为满',
    full && full.conflict === true && full.error === 'port-pool-exhausted'
      && full.capacity && full.capacity.free === 0 && full.capacity.used === 4
      && small.isFull('providerApi') === true, JSON.stringify(full));
  check('allocate 池满返回 null（调用方转显式错误）', (await small.allocate('providerApi', 'overflow2')) === null);

  console.log('== 5) portPools 可配置 ==');
  const custom = new PortRegistry({ file: path.join(TMP, 'custom.json'), pools: Object.assign({}, DEFAULT_POOLS, { providerApi: { base: 28000, count: 8 } }) });
  const cp = await custom.allocate('providerApi', 'x');
  check('configurePools 生效：自定义 base/count，且分配落在自定义池内',
    custom.rangeOf('providerApi').base === 28000 && custom.rangeOf('providerApi').count === 8
    && cp >= 28000 && cp < 28008, JSON.stringify(custom.rangeOf('providerApi')));

  console.log('== 6) 保留池拒用户端口 ==');
  let rejected = false;
  try { reg.registerUser(DEFAULT_POOLS.providerApi.base + 10, 'inst:bad'); } catch { rejected = true; }
  check('providerApi 池内端口被拒为实例端口', rejected);
  const outsidePort = 30000;
  let allowed = true, errMsg = null;
  try { reg.registerUser(outsidePort, 'inst:ok'); } catch (e) { allowed = false; errMsg = e.message; }
  check('池外端口允许为实例端口', allowed, errMsg || ('registered at ' + outsidePort));

  const failed = results.filter((r) => !r);
  console.log('\n结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed, ' + skipped.length + ' skipped');
  if (skipped.length) { console.log('  未验证（环境不具备条件，不计入通过）:'); for (const n of skipped) console.log('    - ' + n); }
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
