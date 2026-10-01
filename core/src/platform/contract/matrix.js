'use strict';

const SUPPORTED = [
  { platform: 'linux', arch: 'x64', osTag: 'linux', npmTag: 'linux-x64' },
  { platform: 'darwin', arch: 'arm64', osTag: 'darwin', npmTag: 'darwin-arm64' },
  { platform: 'darwin', arch: 'x64', osTag: 'darwin', npmTag: 'darwin-x64' },
  { platform: 'win32', arch: 'x64', osTag: 'win', npmTag: 'win-x64' },
];

const OS_TAG = { linux: 'linux', darwin: 'darwin', win32: 'win' };
const FRP_OS = { linux: 'linux', darwin: 'darwin', win32: 'windows' };
const FRP_ARCH = { x64: 'amd64', arm64: 'arm64' };

function osTag(platform) {
  return OS_TAG[platform || process.platform] || null;
}

function current(platform, arch) {
  const p = platform || process.platform;
  const a = arch || process.arch;
  return { platform: p, arch: a, osTag: OS_TAG[p] || null, npmTag: npmTag(p, a) };
}

function npmTag(platform, arch) {
  const p = platform || process.platform;
  const a = arch || process.arch;
  const os = OS_TAG[p];
  if (!os || (a !== 'x64' && a !== 'arm64')) {
    throw new Error('不支持的平台组合: ' + p + '/' + a + '（仅 linux/darwin/win32 × x64/arm64）');
  }
  return os + '-' + a;
}

function isSupported(platform, arch) {
  const p = platform || process.platform;
  const a = arch || process.arch;
  return SUPPORTED.some((x) => x.platform === p && x.arch === a);
}

function frpTag(platform, arch) {
  const p = platform || process.platform;
  const a = arch || process.arch;
  const os = FRP_OS[p];
  const am = FRP_ARCH[a];
  if (!os || !am) return null;
  return { os, arch: am, tag: os + '_' + am, exe: p === 'win32' };
}

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
