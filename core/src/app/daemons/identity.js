'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { isAlive } = require('../../platform/os/pidlookup');

function lockPid(p) {
  if (!p) return null;
  try {
    const n = parseInt(fs.readFileSync(p, 'utf8'), 10);
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch { return null; }
}

function pidAlive(pid) {
  return isAlive(pid);
}

function acquireLock(p, onErr) {
  if (!p) return false;
  const attempt = () => {
    try {
      const fd = fs.openSync(p, 'wx');
      try { fs.writeSync(fd, String(process.pid)); } finally { try { fs.closeSync(fd); } catch {} }
      return true;
    } catch (e) {
      if (e && e.code === 'EEXIST') return false;
      if (onErr) onErr(e);
      return false;
    }
  };
  if (attempt()) return true;
  const holder = lockPid(p);
  if (holder === process.pid) return true;
  if (holder !== null && pidAlive(holder)) return false;
  try { fs.unlinkSync(p); } catch {}
  return attempt();
}

function releaseLock(p) {
  if (!p) return;
  const holder = lockPid(p);
  if (holder !== null && holder !== process.pid) return;
  try { fs.unlinkSync(p); } catch {}
}

const DEPS = new WeakMap();
function depsOf(host) {
  let d = DEPS.get(host);
  if (!d) {
    d = {
      config() { return host.config; },
      lanLockPath() { return host._lanLockPath(); },
      routerDaemonLockPath() { return host._routerDaemonLockPath(); },
    };
    DEPS.set(host, d);
  }
  return d;
}

module.exports = {
  _lockPrimitives: { acquireLock, releaseLock, lockPid, pidAlive },
  methods: {
    _lanLockPath() { const d = depsOf(this); try { return path.join(path.dirname(d.config().stateFile), 'lan-daemon.lock'); } catch { return null; } },
    _lanManaged() { const d = depsOf(this); try { const p = d.lanLockPath(); return !!p && fs.existsSync(p); } catch { return false; } },
    _writeLanLock() { const d = depsOf(this); try { return acquireLock(d.lanLockPath()); } catch { return false; } },
    _clearLanLock() { const d = depsOf(this); try { releaseLock(d.lanLockPath()); } catch {} },

    _routerDaemonLockPath() {
      const d = depsOf(this);
      try { return path.join(path.dirname(d.config().stateFile), 'router-daemon.lock'); } catch { return null; }
    },

    _daemonManaged() {
      const d = depsOf(this);
      try { const p = d.routerDaemonLockPath(); return !!p && fs.existsSync(p); } catch { return false; }
    },

    _writeRouterDaemonLock() {
      const d = depsOf(this);
      try { return acquireLock(d.routerDaemonLockPath()); } catch { return false; }
    },

    _clearRouterDaemonLock() {
      const d = depsOf(this);
      try { releaseLock(d.routerDaemonLockPath()); } catch {}
    },
  },
};
