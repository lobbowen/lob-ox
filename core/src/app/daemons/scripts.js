'use strict';

const path = require('node:path');
const { resolve } = require('../../platform/util/srcpath');

const DAEMON_REL = {
  router: path.join('domains', 'router', 'daemon.js'),
  lan: path.join('domains', 'relay', 'daemon.js'),
};

function daemonScript(kind) {
  const rel = DAEMON_REL[kind];
  if (!rel) return null;
  return resolve(rel);
}

module.exports = { daemonScript, DAEMON_REL };
