'use strict';
module.exports = function registerCleanup(listProviders) {
  process.on('exit', () => {
    try {
      const providers = typeof listProviders === 'function' ? listProviders() : [];
      for (const p of providers || []) {
        for (const i of (p.instances || [])) {
          if (i.pid) { try { process.kill(i.pid, 'SIGKILL'); } catch {} i.pid = null; }
        }
      }
    } catch {}
  });
};
