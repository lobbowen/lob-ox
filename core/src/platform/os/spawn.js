'use strict';

const { spawn } = require('node:child_process');

function detached(cmd, args, opts) {
  const o = opts || {};
  return spawn(cmd, args, Object.assign({}, o, {
    detached: true,
    windowsHide: true,
    stdio: o.stdio === undefined ? 'ignore' : o.stdio,
  }));
}

function piped(cmd, args, opts) {
  const o = opts || {};
  return spawn(cmd, args, Object.assign({}, o, {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    detached: o.detached === true,
  }));
}

function detachedIgnored(cmd, args, opts) {
  const o = opts || {};
  return spawn(cmd, args, Object.assign({}, o, {
    detached: true,
    windowsHide: true,
    stdio: 'ignore',
  }));
}

module.exports = { detached, piped, detachedIgnored };
