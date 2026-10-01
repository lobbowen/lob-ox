#!/usr/bin/env node
'use strict';

// 四平台行为穷举：在 Linux 上一次本地断言穷尽 linux-x64 / darwin-arm64 / darwin-x64 / win-x64 的
//   平台分派结果（matrix.js 与 capabilityProfile() 都接受显式 platform/arch）。证明的是**逻辑**，
//   平台原生行为（真 systemd/launchd/schtasks）仍须真实四平台 CI 裁决。P-5 档位 / P-6 运行时与矩阵同源 / P-7 guardCorePkg 模板。

const path = require('node:path');
const { execFileSync } = require('node:child_process');
const ROOT = path.join(__dirname, '..');
const matrix = require(path.join(ROOT, 'src', 'platform', 'contract', 'matrix.js'));
const osLayer = require(path.join(ROOT, 'src', 'platform', 'os', 'index.js'));

const results = [];
const check = (n, c, x) => {
  results.push(!!c);
  console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  ← ' + x : ''));
};

/** 在子进程里伪造 platform/arch 后执行一段代码（跨平台逻辑的既验技术）。 */
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

// -- P-5：关键档位取值（差异点必须显式声明）--
{
  const L = osLayer.capabilityProfile('linux', 'x64');
  const D = osLayer.capabilityProfile('darwin', 'x64');
  const W = osLayer.capabilityProfile('win32', 'x64');
  const U = osLayer.capabilityProfile('freebsd', 'x64');
  //  字段拆分：拉起能力与限额执行档位是两个正交维度（W3 落地：三平台都能跑舱，但限额强制不同档）。
  //  只判「三平台都是显式档位而非 none、未知平台一律 none」，不锁具体档位字符串（实现档位可选）。
  check('P-5 三平台可跑舱且限额为显式档位；未知平台一律 false/none（不谎报）',
    L.sandboxLaunch === true && D.sandboxLaunch === true && W.sandboxLaunch === true && U.sandboxLaunch === false
    && [L, D, W].every((x) => typeof x.sandboxEnforcement === 'string' && x.sandboxEnforcement !== 'none')
    && U.sandboxEnforcement === 'none',
    [L, D, W, U].map((x) => x.sandboxLaunch + '/' + x.sandboxEnforcement).join(' '));
  check('P-5 hostService 与平台一一对应（systemd/launchd/windows-service/none）',
    L.hostService === 'systemd' && D.hostService === 'launchd'
    && W.hostService === 'windows-service' && U.hostService === 'none',
    [L, D, W, U].map((x) => x.hostService).join(','));
  // sandboxEnforcement 是枚举字符串（未知平台='none'），不在「其余全 false」断言范围内。
  check('P-5 未知平台全 false（显式 Unsupported，绝不静默成功）',
    Object.entries(U).every(([k, v]) => (k === 'platform' || k === 'arch' || k === 'hostService' || k === 'sandboxEnforcement') || v === false),
    JSON.stringify(U));
  //  重要区分：capabilityProfile.processTreeKill（含 Windows taskkill /T）与
  //   matrix.supportsProcessGroup（仅 POSIX kill(-pid)）**语义不同**，不得混用。
  //  本档位是全仓唯一采样点（platform-matrix-single-source 的同名站已回并到这里）。
  check('P-5 processTreeKill 三平台皆真（Windows 经 taskkill /T）而 supportsProcessGroup 仅 POSIX',
    L.processTreeKill === true && W.processTreeKill === true
    && matrix.supportsProcessGroup('win32') === false && matrix.supportsProcessGroup('linux') === true
    && matrix.supportsProcessGroup('darwin') === true,
    '两者语义不同，已在文档中区分');
}

// -- P-6：运行时与矩阵一致（真实模块在伪造平台下的产出）--
{
  const distPath = path.join(ROOT, 'src', 'platform', 'distribution', 'index.js');
  // 夹具源码只写一次。
  const tagSrc = (wrap) => [
    "const { DistributionManager } = require(" + JSON.stringify(distPath) + ");",
    "const d = Object.create(DistributionManager.prototype);",
    wrap
      ? "try { process.stdout.write(String(d._platformTag())); } catch (e) { process.stdout.write('ERR:' + e.message); }"
      : "process.stdout.write(String(d._platformTag()));",
  ].join(String.fromCharCode(10));
  const tag = (p, a, wrap) => underFake(p, a, tagSrc(wrap));
  // 代表样本（四组合取值由 platform-matrix-single-source 承担）：win32/x64 捕「osTag 是 win 而不是 win32」，
  //   linux/arm64 捕 arch 段。
  for (const [p, a, want] of [['win32', 'x64', 'win-x64'], ['linux', 'arm64', 'linux-arm64']]) {
    const out = tag(p, a);
    check('P-6 ' + p + '/' + a + ' _platformTag() == matrix.npmTag（运行时与矩阵同源）',
      out === want, out + ' vs ' + want);
  }
  const bad = tag('freebsd', 'x64', true);
  check('P-6 不支持的平台：_platformTag 抛错且文案含平台组合',
    bad.startsWith('ERR:') && /不支持的平台组合/.test(bad), bad.slice(0, 60));

  // 已知 OS + **未知 arch**：`arch === 'arm64' ? 'arm64' : 'x64'` 会把 ppc64le / s390x / ia32 静默当 x64
  //   -> 轻则 404，重则下载到架构不符的包。只断言「抛错」，不匹配错误文案。
  const badArch = tag('linux', 'ppc64', true);
  check('P-6 已知 OS + 未知 arch（linux/ppc64）：_platformTag 抛错，不得回落 x64',
    badArch.startsWith('ERR:'), badArch.slice(0, 60));
}

// -- P-7：消费方契约 —— guardCorePkg 的 {os}/{arch} 替换 --
{
  // guardCorePkg 落在 app/settings/versions.js（**不在** env.js），且模块导出形态为 { methods }：
  //   desc.guardCorePkg 为 undefined，必须读 desc.methods.guardCorePkg。
  const svPath = path.join(ROOT, 'src', 'app', 'settings', 'versions.js');
  // 代表样本：win32/x64 捕「{os} 是 win 而不是 win32」，linux/x64 捕基线（darwin 段无独立风险面）。
  for (const [p, a, want] of [
    ['linux', 'x64', '@dsh-sup/dsh-core-linux-x64'],
    ['win32', 'x64', '@dsh-sup/dsh-core-win-x64'],
  ]) {
    const out = underFake(p, a, [
      "const desc = require(" + JSON.stringify(svPath) + ");",
      "const o = { config: { corePackageName: '@dsh-sup/dsh-core-{os}-{arch}' } };",
      "Object.defineProperty(o, 'guardCorePkg', { value: desc.methods.guardCorePkg });",
      "process.stdout.write(String(o.guardCorePkg()));",
    ].join(String.fromCharCode(10)));
    check('P-7 ' + p + '/' + a + ' guardCorePkg 模板替换正确', out === want, out + ' vs ' + want);
  }
}

const failed = results.filter((r) => !r);
console.log(String.fromCharCode(10) + '结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
process.exit(failed.length ? 1 : 0);
