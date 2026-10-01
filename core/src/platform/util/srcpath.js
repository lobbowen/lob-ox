'use strict';

const fs = require('node:fs');
const path = require('node:path');

const SELF_REL = path.join('platform', 'util', 'srcpath.js');

function _candidateRoots() {
  return [
    { label: '__dirname/../..', path: path.join(__dirname, '..', '..') },
    { label: '__dirname/../../../src', path: path.join(__dirname, '..', '..', '..', 'src') },
    { label: 'cwd/src', path: path.join(process.cwd(), 'src') },
  ];
}

let _root = null;

function resolveSrcRoot() {
  if (_root) return _root;
  for (const p of _candidateRoots()) {
    if (fs.existsSync(path.join(p.path, SELF_REL))) {
      _root = p.path;
      return _root;
    }
  }
  return null;
}

function resolve(relPath) {
  if (typeof relPath !== 'string' || relPath === '') return null;
  const root = resolveSrcRoot();
  if (!root) return null;
  const p = path.join(root, relPath);
  return fs.existsSync(p) ? p : null;
}

function describe() {
  return {
    resolved: resolveSrcRoot(),
    candidates: _candidateRoots().map((p) => ({
      label: p.label,
      path: p.path,
      selfModule: fs.existsSync(path.join(p.path, SELF_REL)),
    })),
  };
}

function resolvePackageRoot() {
  let dir = __dirname;
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  if (fs.existsSync(path.join(process.cwd(), 'package.json'))) return process.cwd();
  return null;
}

module.exports = { resolve, resolvePackageRoot, describe };
