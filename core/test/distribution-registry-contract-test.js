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

  const failed = results.filter((r) => !r);
  console.log('\n结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
