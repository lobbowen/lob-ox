'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { npxBin } = require('./exec-path');

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
