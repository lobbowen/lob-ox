'use strict';

// 原生 DSH 安装链路回归测试（0.0.19 P0）。
//
// 症状：发布 0.0.19 后，点「安装 DeepSeek Harness」直接报「dsh 安装失败」。
// 三个缺陷叠加，全部藏在适配层与镜像源选择里，单元测试各自 mock 依赖所以全绿：
//   1. 适配器从不解析 npmRoot，null 被 agent 域拒绝（「原生形态需显式提供 npmRoot」）
//   2. /native/install 不传 version，null 透传到 dist 报「缺少 version」
//   3. 镜像契约缺失时 probeOrAdopt 把所有源判为不可达，ordered 退化为配置顺序，
//      首个是访问不了的官方源 → npm 挂死到超时，output 为空、无任何日志
//
// 本测试锁定三处修法，防止再次回退。

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const assert = require('node:assert');

let pass = 0;
const fails = [];
function check(n, f) { try { f(); pass++; } catch (e) { fails.push(n + ': ' + e.message); } }

const CORE = 'C:/work/lob-ox/core/src';

// ---- 1. npmRoot 必须能自解析（不依赖调用方传入）----
check('适配器有 npmRoot 惰性解析', () => {
  const a = fs.readFileSync(CORE + '/domains/agent/native-adapter.js', 'utf8');
  assert.ok(/async _resolveNpmRoot/.test(a), '应存在 _resolveNpmRoot');
  assert.ok(/root', '-g'/.test(a), '应调用 npm root -g 解析');
  assert.ok(/_npmRootCache/.test(a), '应有解析缓存（避免每次安装都探测）');
});

check('install 使用解析后的 npmRoot 而非原始 null', () => {
  const a = fs.readFileSync(CORE + '/domains/agent/native-adapter.js', 'utf8');
  assert.ok(/const npmRoot = await this\._resolveNpmRoot\(\);/.test(a),
    'install 必须先解析 npmRoot');
  assert.ok(/if \(npmRoot\) this\.npmRoot = npmRoot;/.test(a),
    '解析成功应固化到 this.npmRoot，否则 installedVersion 永远查不到');
});

check('_prefix 回退到解析缓存', () => {
  const a = fs.readFileSync(CORE + '/domains/agent/native-adapter.js', 'utf8');
  assert.ok(/this\._npmRootCache \|\| null/.test(a),
    '_prefix 应在 this.npmRoot 为空时用缓存值');
});

// ---- 2. version 缺省 = 装最新，不得把 null 透传 ----
check('startInstall 放行 null version', () => {
  const a = fs.readFileSync(CORE + '/domains/agent/native-adapter.js', 'utf8');
  assert.ok(/if \(version && !status\.isValidVersion\(version\)\)/.test(a),
    'null 应放行（装最新），只有给了值才校验格式');
});

check('install 在 version 缺省时解析 latest', () => {
  const a = fs.readFileSync(CORE + '/domains/agent/native-adapter.js', 'utf8');
  assert.ok(/createLatestResolver/.test(a), '应解析 latest 而非传 null');
  assert.ok(/const pick = await resolver\(this\._pkg\(\)\);/.test(a),
    '应调用 resolver 拿最新版');
  assert.ok(/target = pick && pick\.ok \? pick\.version : null;/.test(a),
    'resolver 返回的是响应对象，必须取 .version');
});

check('dist.runNpmInstall 要求 version（null 会被拒）', () => {
  const d = fs.readFileSync(CORE + '/platform/distribution/install.js', 'utf8');
  assert.ok(/runNpmInstall: 缺少版本/.test(d) || /缺少 version/.test(d),
    'dist 侧确实要求 version——这正是必须解析 latest 的原因');
});

// ---- 3. 契约缺失时内核必须自实测，不能把所有源判死 ----






// ---- 4. 端到端：装配出的 nativeAgent 能解析出可用源与 npmRoot ----
const ASYNC = [];
function checkAsync(n, f) { ASYNC.push([n, f]); }

checkAsync('端到端：_selectRegistry 能给出可用源', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-install-reg-'));
  const cfgPath = path.join(dir, 'config.json');
  const PORT = 49000 + Math.floor(Math.random() * 5000);
  fs.writeFileSync(cfgPath, JSON.stringify({
    targetPort: PORT,
    healthUrl: 'http://127.0.0.1:' + PORT + '/health',
    command: ['dsh'],
    stateFile: path.join(dir, 'supervisor', 'state.json'),
    updateCheckEnabled: false,
    tickIntervalMs: 5000,
  }, null, 2));
  let host = {};
  try {
    const { composeSystem } = require(CORE + '/app/assembly/compose');
    const { createServer } = require(CORE + '/api/index');
    composeSystem(host, require(cfgPath), cfgPath, { createServer });
    assert.ok(host.nativeAgent, '适配器应在位');
    // 镜像源：契约缺失环境下必须仍能给出一个源（自实测兜底）
    const reg = await host.nativeAgent._selectRegistry();
    assert.ok(typeof reg === 'string' && /^https?:\/\//.test(reg),
      '_selectRegistry 必须返回一个源，得到: ' + JSON.stringify(reg));
    // npmRoot：必须能自解析（不依赖调用方传）
    const root = await host.nativeAgent._resolveNpmRoot();
    assert.ok(typeof root === 'string' && root.length > 0,
      '_resolveNpmRoot 必须解析出全局前缀，得到: ' + JSON.stringify(root));
    // 解析后 _prefix 应立即可用（installedVersion 依赖它）
    assert.strictEqual(host.nativeAgent._prefix(), root,
      '_prefix 应等于解析结果');
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {  }
  }
});

(async () => {
  for (const [n, f] of ASYNC) {
    try { await f(); pass++; } catch (e) { fails.push(n + ': ' + e.message); }
  }
  console.log('原生安装链路回归测试: ' + pass + ' 通过, ' + fails.length + ' 失败');
  if (fails.length) { console.log(fails.map((f) => '  x ' + f).join(String.fromCharCode(10))); process.exit(1); }
  console.log('ALL NATIVE-INSTALL REGRESSION TESTS PASS');
})();