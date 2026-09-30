#!/usr/bin/env node
'use strict';

// 动态端口池容量与弹性回归：
//   1) 大量对象可持续分配，远超旧的固定小段上限（如 providerApi 旧 32）；
//   2) 选址避开 OS 动态端口范围且落在合法区间；3) 共享池不同锚点互不挤占；
//   4) 池满 -> 显式 ErrFull（不再静默 null），capacity()/available()/isFull() 可观测；
//   5) portPools 可配置覆盖；6) 保留池拒绝用户实例端口。
// 自包含：独立临时注册表文件 + 大跨度测试池，不触碰生产 ports.json。

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ports-capacity-'));
const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined ? '  ← ' + x : '')); };

(async () => {
  const { PortRegistry, DEFAULT_POOLS, SEGMENT_POOL } = require(path.join(ROOT, 'src', 'platform', 'service', 'ports'));
  // DS-G4 （反转法）：段名/独立池是**域知识**，platform 不再硬编码 -> 测试显式申报
  // （等价于生产由 router/relay 域装配期注入；未申报时未注册段回退通用池 managed）。
  require(path.join(ROOT, 'src', 'domains', 'router', 'port-segments'));
  require(path.join(ROOT, 'src', 'domains', 'relay', 'port-segments'));

  // 1) 选址：默认池必须完全避开 OS 动态端口范围，且在合法端口区间
  console.log('== 1) 池选址（RFC 6335 / 避开 OS ephemeral）==');
  const ephemeral = (() => {
    try {
      const raw = fs.readFileSync('/proc/sys/net/ipv4/ip_local_port_range', 'utf8').trim().split(/\s+/);
      const lo = Number(raw[0]), hi = Number(raw[1]);
      return (Number.isInteger(lo) && Number.isInteger(hi)) ? { lo, hi } : null;
    } catch { return null; }
  })();
  // （原「默认池定义存在且含 managed/providerApi」是后续全部断言的前提，已删：缺定义时下面必红且可定位）
  const overlaps = (p) => !!ephemeral && !(p.base + p.count - 1 < ephemeral.lo || p.base > ephemeral.hi);
  check('默认池避开 OS 动态端口范围且在合法端口区间(1024-65535)',
    !Object.values(DEFAULT_POOLS).some(overlaps)
    && Object.values(DEFAULT_POOLS).every((p) => p.base >= 1024 && p.base + p.count - 1 <= 65535),
    ephemeral ? ('ephemeral=' + ephemeral.lo + '-' + ephemeral.hi + ' pools=' + JSON.stringify(DEFAULT_POOLS)) : 'no /proc (skip range)');

  // 2) 规模：providerApi 轻松容纳 200+ 供应商（旧实现 32 即满）
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

  // 3) 共享池：同池不同锚点，确定性且互不挤占
  console.log('== 3) 共享池（K8s 单一范围思想）==');
  const rp = await reg.allocate('relay', 'relay:a');
  const pp = await reg.allocate('proxyInstance', 'proxy:b');
  const op = await reg.allocate('oauthCallback', 'oauth:c');
  check('三段锚点不同（确定性起点）', rp !== pp && pp !== op && rp !== op, JSON.stringify({ rp, pp, op }));
  // 同池模型两面合一：段->池映射声明一致 + 分配确实落在同一池范围（互不挤占 = 共享余量）
  check('relay/proxyInstance/oauthCallback 同池（声明一致 + 分配不互相覆盖）',
    SEGMENT_POOL.relay === SEGMENT_POOL.proxyInstance && SEGMENT_POOL.proxyInstance === SEGMENT_POOL.oauthCallback
      && [rp, pp, op].every((p) => p >= DEFAULT_POOLS.managed.base && p < DEFAULT_POOLS.managed.base + DEFAULT_POOLS.managed.count));

  // 4) 池满 -> 显式错误（绝不静默 null）
  console.log('== 4) 池满显式错误 ==');
  const small = new PortRegistry({ file: path.join(TMP, 'small.json'), pools: Object.assign({}, DEFAULT_POOLS, { providerApi: { base: 27000, count: 4 } }) });
  for (let i = 0; i < 4; i++) await small.allocate('providerApi', 's' + i);
  const full = await small.claimSlot('providerApi', 'overflow');
  check('池满 claimSlot 返回显式 conflict/ErrFull + capacity 可观测 + isFull() 为满',
    full && full.conflict === true && full.error === 'port-pool-exhausted'
      && full.capacity && full.capacity.free === 0 && full.capacity.used === 4
      && small.isFull('providerApi') === true, JSON.stringify(full));
  check('allocate 池满返回 null（调用方转显式错误）', (await small.allocate('providerApi', 'overflow2')) === null);

  // 5) 可配置池（工业标准：范围是配置项）
  console.log('== 5) portPools 可配置 ==');
  const custom = new PortRegistry({ file: path.join(TMP, 'custom.json'), pools: Object.assign({}, DEFAULT_POOLS, { providerApi: { base: 28000, count: 8 } }) });
  const cp = await custom.allocate('providerApi', 'x');
  check('configurePools 生效：自定义 base/count，且分配落在自定义池内',
    custom.rangeOf('providerApi').base === 28000 && custom.rangeOf('providerApi').count === 8
    && cp >= 28000 && cp < 28008, JSON.stringify(custom.rangeOf('providerApi')));

  // 6) 保留池拒绝用户实例端口
  console.log('== 6) 保留池拒用户端口 ==');
  let rejected = false;
  try { reg.registerUser(DEFAULT_POOLS.providerApi.base + 10, 'inst:bad'); } catch { rejected = true; }
  check('providerApi 池内端口被拒为实例端口', rejected);
  // 池外端口（30000：大于 managed 与 providerApi 池，且避开 OS dynamic）
  const outsidePort = 30000;
  let allowed = true, errMsg = null;
  try { reg.registerUser(outsidePort, 'inst:ok'); } catch (e) { allowed = false; errMsg = e.message; }
  check('池外端口允许为实例端口', allowed, errMsg || ('registered at ' + outsidePort));

  const failed = results.filter((r) => !r);
  console.log('\n结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
