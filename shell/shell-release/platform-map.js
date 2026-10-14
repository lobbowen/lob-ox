#!/usr/bin/env node
'use strict';

// 6 平台双向映射的唯一权威。
// 消费方（全部 require 本文件，不得再各自硬编码）：
//   assemble-shell-pkg.js  正向 plat → { os, cpu, manifestKey, installer }
//   make-manifest.js       反向 manifestKey → npmPlat（拼 unpkg URL）
//   verify-channel.js      反向 manifestKey → 本次构建产物目录（npm 包目录名）
//   .github/workflows/shell.yml  用 node -p 取 npmPlat（归拢后的哨兵目录名）
//
// 反向映射由正向表推导，不单独维护第二份 ⇒ 正向一改，反向必然跟随，不可能分叉。

const PLATFORMS = {
  'linux-x64':    { os: 'linux',  cpu: 'x64',   manifestKey: 'linux-x86_64',   installer: 'deb'  },
  'linux-arm64':  { os: 'linux',  cpu: 'arm64', manifestKey: 'linux-aarch64',  installer: 'deb'  },
  'darwin-x64':   { os: 'darwin', cpu: 'x64',   manifestKey: 'darwin-x86_64',  installer: 'app'  },
  'darwin-arm64': { os: 'darwin', cpu: 'arm64', manifestKey: 'darwin-aarch64', installer: 'app'  },
  'win-x64':      { os: 'win32',  cpu: 'x64',   manifestKey: 'windows-x86_64', installer: 'nsis' },
  'win-arm64':    { os: 'win32',  cpu: 'arm64', manifestKey: 'windows-aarch64',installer: 'nsis' },
};

const PLATS = Object.keys(PLATFORMS);

// 反向：manifestKey -> plat（npm 包名后缀）
const PLAT_BY_MANIFEST_KEY = Object.freeze(
  PLATS.reduce((m, p) => { m[PLATFORMS[p].manifestKey] = p; return m; }, {})
);

// 反向：plat -> npm 包目录名（assemble-shell-pkg.js 的 --out/<dir>）
// ⚠ 与 assemble 的 path.join(out, pkgName) 必须一致：verify-channel 靠它定位本次构建产物。
function npmPkgDir(plat) {
  const meta = PLATFORMS[plat];
  if (!meta) throw new Error('未知平台: ' + plat);
  return '@lob-ox/shell-' + plat;
}

// 反向查询：manifestKey -> plat，未知键原样返回（保持旧行为：未知即视为 plat 名本身）
function platFromManifestKey(key) {
  return PLAT_BY_MANIFEST_KEY[key] || key;
}

module.exports = { PLATFORMS, PLATS, PLAT_BY_MANIFEST_KEY, npmPkgDir, platFromManifestKey };
