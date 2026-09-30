'use strict';

// npx 的启动形态与缓存落点（平台事实，唯一解析口）。exec-path 管「逻辑名 -> 路径」，本文件管 npx
// 「怎么拉起 / 缓存在哪」；PATH 回退经 exec-path#npxBin（单向依赖，exec-path 不反过来消费本文件）。

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { npxBin } = require('./exec-path');

/** npx 包缓存根目录（跨平台事实，唯一解析口）：POSIX ~/.npm/_npx；
 *  Windows 的 npm 缓存默认根是 %LOCALAPPDATA%\npm-cache，_npx 是其子目录。
 *  @param {{platform?:string,home?:string,env?:object}} [opts] 均可注入，便于纯函数级跨平台测试 */
function npxCacheDir(opts) {
  const o = opts || {};
  const pl = o.platform || process.platform;
  const env = o.env || process.env;
  const h = o.home || os.homedir();
  if (pl === 'win32') {
    const lappd = env.LOCALAPPDATA || path.join(h, 'AppData', 'Local');
    return path.join(lappd, 'npm-cache', '_npx');
  }
  return path.join(h, '.npm', '_npx');
}

/** npx 的成对启动形态 {program, args, source}（与 contract/runtime#npmLauncher 同词汇）：
 *  node 直启 npm 发行自带的 npx-cli.js——win32 上 npxBin() 给的是 npx.cmd，而 Node >=18.20/20.12
 *  （CVE-2024-27980）对无 shell 直 spawn .cmd 一律 EINVAL，直启即必炸；探不到 npx-cli.js（非官方 node 发行）退回 PATH 形态。
 *  @param {{platform?:string,execPath?:string}} [opts] */
function npxLauncher(opts) {
  const o = opts || {};
  const pl = o.platform || process.platform;
  const node = o.execPath || process.execPath;
  const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
  const roots = pl === 'win32'
    ? [path.join(path.dirname(node), 'node_modules', 'npm', 'bin')]
    : [path.join(path.dirname(node), '..', 'lib', 'node_modules', 'npm', 'bin'),
       path.join(path.dirname(node), 'lib', 'node_modules', 'npm', 'bin')];
  for (const r of roots) {
    const cli = path.join(r, 'npx-cli.js');
    if (isFile(cli)) return { program: node, args: [path.resolve(cli)], source: 'node-direct' };
  }
  return { program: npxBin({ platform: pl }), args: [], source: 'path' };
}

module.exports = { npxCacheDir, npxLauncher };
