'use strict';

// 平台矩阵：跨平台知识的唯一合法位置。process.platform / process.arch 只允许出现在
// src/platform/**，业务域必须经本模块或平台层能力取平台事实，不得自建 os/arch 映射表。
// SUPPORTED 与 package.json#npmPublish.packages 逐项一致，由 platform-matrix-single-source-test
// 与 cross-platform-architecture-gate-test 两道门禁守住。

/** 受支持平台组合（顺序即发布顺序）。platform/arch 为 Node 取值；osTag 为 npm 包名 os 段；
 *  npmTag 为子包尾段 <osTag>-<arch>。 */
const SUPPORTED = [
  { platform: 'linux', arch: 'x64', osTag: 'linux', npmTag: 'linux-x64' },
  { platform: 'darwin', arch: 'arm64', osTag: 'darwin', npmTag: 'darwin-arm64' },
  { platform: 'darwin', arch: 'x64', osTag: 'darwin', npmTag: 'darwin-x64' },
  { platform: 'win32', arch: 'x64', osTag: 'win', npmTag: 'win-x64' },
];

/** npm/产物 os 段映射表。 */
const OS_TAG = { linux: 'linux', darwin: 'darwin', win32: 'win' };
/** process.platform 到 FRP 官方 os 段（第三方命名，无法统一：frp 用 windows 而非 win）。 */
const FRP_OS = { linux: 'linux', darwin: 'darwin', win32: 'windows' };
/** process.arch 到 FRP 官方 arch 段（frp 用 amd64 而非 x64）。 */
const FRP_ARCH = { x64: 'amd64', arm64: 'arm64' };

/** process.platform 到 npm/产物 os 段；不支持返回 null。默认取 process.platform。 */
function osTag(platform) {
  return OS_TAG[platform || process.platform] || null;
}

/** 当前平台/架构事实（业务域取平台事实的入口之一）。 */
function current(platform, arch) {
  const p = platform || process.platform;
  const a = arch || process.arch;
  return { platform: p, arch: a, osTag: OS_TAG[p] || null, npmTag: npmTag(p, a) };
}

/** <osTag>-<arch>；不支持时抛错。注意：错误文案是既有对外契约（测试断言其内容），不得改动。 */
function npmTag(platform, arch) {
  const p = platform || process.platform;
  const a = arch || process.arch;
  const os = OS_TAG[p];
  if (!os || (a !== 'x64' && a !== 'arm64')) {
    throw new Error('不支持的平台组合: ' + p + '/' + a + '（仅 linux/darwin/win32 × x64/arm64）');
  }
  return os + '-' + a;
}

/** 是否属于 SUPPORTED（即发布矩阵）同集合，不发错。linux-arm64 / win32-arm64 当前不在矩阵。 */
function isSupported(platform, arch) {
  const p = platform || process.platform;
  const a = arch || process.arch;
  return SUPPORTED.some((x) => x.platform === p && x.arch === a);
}

/** FRP 客户端官方产物标签；不支持返回 null（调用方据此如实上报）。
 *  FRP 命名与 npm 不同（windows/amd64），故必须保留独立映射。 */
function frpTag(platform, arch) {
  const p = platform || process.platform;
  const a = arch || process.arch;
  const os = FRP_OS[p];
  const am = FRP_ARCH[a];
  if (!os || !am) return null;
  return { os, arch: am, tag: os + '_' + am, exe: p === 'win32' };
}

/** 平台是否支持 POSIX 进程组语义（kill(-pid) 整树终止）；Windows 退化为单进程终止。 */
function supportsProcessGroup(platform) {
  return (platform || process.platform) !== 'win32';
}

module.exports = {
  SUPPORTED,
  osTag,
  current,
  npmTag,
  isSupported,
  frpTag,
  supportsProcessGroup,
};
