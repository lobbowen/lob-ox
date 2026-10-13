'use strict';

const stateRoot = require('../service/state-root');

const fs = require('node:fs');
const path = require('node:path');
const execPath = require('../os/exec-path');

const SUPPORTED_SCHEMA = 2;

function file() {
  return path.join(stateRoot.supervisorDir(), 'runtime.json');
}

function read() {
  let j;
  try {
    j = JSON.parse(fs.readFileSync(file(), 'utf8'));
  } catch {
    return null;
  }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return null;
  // D.8-P2-8：schema 必须校验。此前只记录不校验，而 registry.js 与 shell-report.js
  // 都有严格的 schema 拒绝逻辑——runtime 是三者中唯一的缺口。schema 3 若改了字段名，
  // 旧内核会静默误读（取不到值退化成 PATH 查找），表现为「明明装了 Node 却找不到」。
  // 与 registry.js 的口径一致：大于 SUPPORTED_SCHEMA 一律拒绝（fail-closed）。
  const schema = Number(j.schema);
  if (Number.isFinite(schema) && schema > SUPPORTED_SCHEMA) return null;
  const node = (j.node && typeof j.node === 'object') ? j.node : {};
  const npm = (j.npm && typeof j.npm === 'object') ? j.npm : {};
  return {
    schema: Number.isFinite(schema) ? schema : 1,
    nodePath: j.nodePath || node.path || null,
    nodeVersion: j.nodeVersion || node.version || null,
    nodeBinDir: j.nodeBinDir || node.binDir || null,
    npmPath: j.npmPath || npm.path || null,
    npmArgs: Array.isArray(j.npmArgs) ? j.npmArgs : (Array.isArray(npm.args) ? npm.args : []),
    npmVersion: (typeof npm.version === 'string' && npm.version) || null,
    minNode: j.minNode || null,
    writtenBy: j.writtenBy || null,
    source: j.source || null,
    installedAt: j.installedAt || null,
    raw: j,
  };
}

function npmLauncher(opts) {
  const c = read();
  if (c && c.npmPath) {
    let exists = false;
    try { exists = fs.existsSync(c.npmPath); } catch {}
    if (exists) return { program: c.npmPath, args: c.npmArgs.map(String), version: c.npmVersion, source: 'contract' };
  }
  return { program: execPath.npmBin(opts), args: [], version: null, source: 'path' };
}

function withPath(env) {
  const e = Object.assign({}, env || {});
  const c = read();
  if (c && c.nodeBinDir) {
    const cur = e.PATH || e.Path || '';
    e.PATH = c.nodeBinDir + path.delimiter + cur;
  }
  return e;
}

module.exports = { SUPPORTED_SCHEMA, file, read, npmLauncher, withPath };
