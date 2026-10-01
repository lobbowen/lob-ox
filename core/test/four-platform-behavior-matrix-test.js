#!/usr/bin/env node
'use strict';


const path = require('node:path');
const { execFileSync } = require('node:child_process');
const ROOT = path.join(__dirname, '..');
const matrix = require(path.join(ROOT, 'src', 'platform', 'contract', 'matrix.js'));
const osLayer = require(path.join(ROOT, 'src', 'platform', 'os', 'index.js'));
const BRAND = require(path.join(ROOT, 'src', 'shared', 'brand.js'));

const results = [];
const check = (n, c, x) => {
  results.push(!!c);
  console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  ← ' + x : ''));
};

function underFake(platform, arch, body) {
  const code = [
    "Object.defineProperty(process, 'platform', { value: " + JSON.stringify(platform) + " });",
    "Object.defineProperty(process, 'arch', { value: " + JSON.stringify(arch) + " });",
    body,
  ].join(String.fromCharCode(10));
  try {
    return execFileSync(process.execPath, ['-e', code], { encoding: 'utf8', timeout: 15000 }).trim();
  } catch (e) {
    return 'EXECFAIL:' + ((e && e.message) || e);
  }
}

{
  const L = osLayer.capabilityProfile('linux', 'x64');
  const D = osLayer.capabilityProfile('darwin', 'x64');
  const W = osLayer.capabilityProfile('win32', 'x64');
  const U = osLayer.capabilityProfile('freebsd', 'x64');
  check('P-5 三平台可跑舱且限额为显式档位；未知平台一律 false/none（不谎报）',
    L.sandboxLaunch === true && D.sandboxLaunch === true && W.sandboxLaunch === true && U.sandboxLaunch === false
    && [L, D, W].every((x) => typeof x.sandboxEnforcement === 'string' && x.sandboxEnforcement !== 'none')
    && U.sandboxEnforcement === 'none',
    [L, D, W, U].map((x) => x.sandboxLaunch + '/' + x.sandboxEnforcement).join(' '));
  check('P-5 hostService 与平台一一对应（systemd/launchd/windows-service/none）',
    L.hostService === 'systemd' && D.hostService === 'launchd'
    && W.hostService === 'windows-service' && U.hostService === 'none',
    [L, D, W, U].map((x) => x.hostService).join(','));
  check('P-5 未知平台全 false（显式 Unsupported，绝不静默成功）',
    Object.entries(U).every(([k, v]) => (k === 'platform' || k === 'arch' || k === 'hostService' || k === 'sandboxEnforcement') || v === false),
    JSON.stringify(U));
  // capabilityProfile.processTreeKill（含 Windows taskkill /T）与 matrix.supportsProcessGroup（仅 POSIX kill(-pid)）语义不同，不得混用。
  check('P-5 processTreeKill 三平台皆真（Windows 经 taskkill /T）而 supportsProcessGroup 仅 POSIX',
    L.processTreeKill === true && W.processTreeKill === true
    && matrix.supportsProcessGroup('win32') === false && matrix.supportsProcessGroup('linux') === true
    && matrix.supportsProcessGroup('darwin') === true,
    '两者语义不同，已在文档中区分');
}

{
  const distPath = path.join(ROOT, 'src', 'platform', 'distribution', 'index.js');
  const tagSrc = (wrap) => [
    "const { DistributionManager } = require(" + JSON.stringify(distPath) + ");",
    "const d = Object.create(DistributionManager.prototype);",
    wrap
      ? "try { process.stdout.write(String(d._platformTag())); } catch (e) { process.stdout.write('ERR:' + e.message); }"
      : "process.stdout.write(String(d._platformTag()));",
  ].join(String.fromCharCode(10));
  const tag = (p, a, wrap) => underFake(p, a, tagSrc(wrap));
  for (const [p, a, want] of [['win32', 'x64', 'win-x64'], ['linux', 'arm64', 'linux-arm64']]) {
    const out = tag(p, a);
    check('P-6 ' + p + '/' + a + ' _platformTag() == matrix.npmTag（运行时与矩阵同源）',
      out === want, out + ' vs ' + want);
  }
  const bad = tag('freebsd', 'x64', true);
  check('P-6 不支持的平台：_platformTag 抛错且文案含平台组合',
    bad.startsWith('ERR:') && /不支持的平台组合/.test(bad), bad.slice(0, 60));

  const badArch = tag('linux', 'ppc64', true);
  check('P-6 已知 OS + 未知 arch（linux/ppc64）：_platformTag 抛错，不得回落 x64',
    badArch.startsWith('ERR:'), badArch.slice(0, 60));
}

{
  // guardCorePkg 落在 app/settings/versions.js（不在 env.js），导出形态为 { methods } ⇒ 必须读 desc.methods.guardCorePkg。
  const svPath = path.join(ROOT, 'src', 'app', 'settings', 'versions.js');
  for (const [p, a, want] of [
    // 期望名保持为**独立预言字面量**（不取自单源，避免拿同一个源证明自己）；单源侧的拼接规则由 brand-single-source-test.js 逐字钉住。
    ['linux', 'x64', '@lob-ox/core-linux-x64'],
    ['win32', 'x64', '@lob-ox/core-win-x64'],
  ]) {
    const out = underFake(p, a, [
      "const desc = require(" + JSON.stringify(svPath) + ");",
      "const o = { config: { corePackageName: '" + BRAND.corePackageName('{os}-{arch}') + "' } };",
      "Object.defineProperty(o, 'guardCorePkg', { value: desc.methods.guardCorePkg });",
      "process.stdout.write(String(o.guardCorePkg()));",
    ].join(String.fromCharCode(10)));
    check('P-7 ' + p + '/' + a + ' guardCorePkg 模板替换正确', out === want, out + ' vs ' + want);
  }
}

const failed = results.filter((r) => !r);
console.log(String.fromCharCode(10) + '结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
process.exit(failed.length ? 1 : 0);
