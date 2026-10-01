'use strict';

const os = require('node:os');

function localAddresses() {
  const out = [];
  try {
    const ifs = os.networkInterfaces();
    for (const name of Object.keys(ifs)) for (const i of ifs[name] || []) {
      if (i.family === 'IPv4' && !i.internal) out.push(i.address);
    }
  } catch {}
  return out;
}

function allManaged({ instances, mainOf }) {
  const sandboxes = (instances && typeof instances.all === 'function' && instances.all()) || [];
  const main = (typeof mainOf === 'function') ? mainOf() : null;
  return main ? [...sandboxes, main] : sandboxes;
}

module.exports = { localAddresses, allManaged };
