#!/usr/bin/env node
'use strict';


const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');

// TTL 守卫值取略大于生产 60s：确保「拨回过去」后必然过期，又不依赖具体实现数值。
const CONTRACT_TTL_GUARD = 61 * 1000;

const results = [];
const check = (n, c, x) => {
  results.push(!!c);
  console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  <- ' + x : ''));
};

(async () => {
  {
    const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dist-contract-'));
    const rf = path.join(TMP, 'registry.json');
    const write = (cat, probe) => fs.writeFileSync(rf, JSON.stringify({
      schema: 2, writtenBy: 'shell', mode: 'auto',
      catalog: [cat], probe: { kind: 'package-metadata', pathTemplate: probe, timeoutMs: 6000 },
    }));
    write('https://boot.example', 'pkg-a');
    const { DistributionManager } = require(path.join(ROOT, 'src', 'platform', 'distribution', 'index.js'));
    const dm = new DistributionManager({ registryFile: rf, registries: ['https://boot.example'] });
    check('C-a 构造时读到启动契约', dm.contract.catalog[0] === 'https://boot.example', JSON.stringify(dm.contract.catalog));

    write('https://new.example', 'pkg-b');
    await dm.registryInfo();

    dm._contractLoadedAt = Date.now() - (CONTRACT_TTL_GUARD);
    await dm.registryInfo();
    check('C-b TTL 过后**重载**并获得新 catalog',
      dm.contract.catalog[0] === 'https://new.example', JSON.stringify(dm.contract.catalog));
    check('C-b 新**探测规格**也生效（这正是「两侧选源不一致」的根因）',
      dm.contract.probe && dm.contract.probe.pathTemplate === 'pkg-b',
      JSON.stringify(dm.contract.probe && dm.contract.probe.pathTemplate));

    dm._contractLoadedAt = Date.now();
    write('https://third.example', 'pkg-c');
    await dm.registryInfo();
    await dm.selectRegistry(true).catch(() => {});
    check('C-c 反向：TTL 内后续调用不重复读盘（仍是 new）',
      dm.contract.catalog[0] === 'https://new.example', JSON.stringify(dm.contract.catalog));

    fs.rmSync(TMP, { recursive: true, force: true });
  }

  {
    const policies = require(path.join(ROOT, 'src', 'platform', 'distribution', 'policies.js'));
    const spec = { kind: 'package-metadata', pathTemplate: 'pkg/{platform}', timeoutMs: 6000 };
    const ping = policies.resolveProbe('https://r.example', spec, null);
    check('C-d resolveProbe(tag=null) 退化 ping、无契约同样 ping 兜底；tag 有效仍走 package-metadata 展开',
      ping.kind === 'ping' && ping.url === 'https://r.example/-/ping'
      && policies.resolveProbe('https://r.example', null, null).kind === 'ping'
      && policies.resolveProbe('https://r.example', spec, 'linux-x64').url === 'https://r.example/pkg/linux-x64',
      JSON.stringify(ping));
  }


  {
    // W3：/dist 探测目标的私网判定此前在 api/domains/dist.js 抄了一份，且**漏了 127/8 整段**
    // （只认 isLoopbackAddress 的 127.0.0.1）⇒ 127.5.5.5 会被判成公网放行。已收敛到 shared/ip 单源。
    // 钉住「回环段非 .0.0.1 的地址也必须拒」——这条在合并前是**安全洞**。
    const distApi = require(path.join(ROOT, 'src', 'api', 'domains', 'dist.js'));
    const ip = require(path.join(ROOT, 'src', 'shared', 'ip.js'));
    const probeErr = (origin) => distApi.probeTargetError ? distApi.probeTargetError(origin, {}) : null;
    // dist.js 未导出 probeTargetError 时退而验证单源判据本身（保证断言不空转）
    const priv = (h) => ip.isPrivateHostLiteral(h);
    check('W3-G 私网判定含 127/8 整段（127.5.5.5 也必须判私网；此前 dist.js 副本只认 127.0.0.1）',
      priv('127.0.0.1') === true && priv('127.5.5.5') === true && priv('8.8.8.8') === false,
      JSON.stringify(['127.0.0.1', '127.5.5.5', '8.8.8.8'].map((h) => h + '=' + priv(h))));
    const src = fs.readFileSync(path.join(ROOT, 'src', 'api', 'domains', 'dist.js'), 'utf8');
    const inlineLeft = (src.match(/o === 169 && t === 254/g) || []).length;
    check('W3-H dist.js 不再内联私网判定（零残留）且取 shared 单源',
      inlineLeft === 0 && /shared\/ip/.test(src) && /isPrivateHostLiteral/.test(src),
      'inline=' + inlineLeft + ' requires=' + /shared\/ip/.test(src));
  }

  const failed = results.filter((r) => !r);
  console.log('\n结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
