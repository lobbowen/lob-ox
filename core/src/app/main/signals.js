'use strict';

const pidlook = require('../../platform/os/pidlookup');
const platform = require('../../platform/os/index');
const { writeAtomic } = require('../../platform/util/fs');
const fs = require('node:fs');
const path = require('node:path');

const ADOPT_KILL_VERIFY_MS = 2000;

const DEPS = new WeakMap();
function depsOf(host) {
  let d = DEPS.get(host);
  if (!d) {
    d = {
      config() { return host.config; },
      events() { return host.events; },
      logger() { return host.logger; },
      mainOwnerFile() { return host._mainOwnerFile(); },
      readMainOwner() { return host._readMainOwner(); },
      signalChild(child, sig) { return host._signalChild(child, sig); },
      killTree(child, sig) { return host._killTree(child, sig); },
      readKillTimer() { return host._killTimer; },
      writeKillTimer(v) { host._killTimer = v; },
      readAdoptKillGen() { return host._adoptKillGen; },
      writeAdoptKillGen(v) { host._adoptKillGen = v; },
      readAdoptKillTimer() { return host._adoptKillTimer; },
      writeAdoptKillTimer(v) { host._adoptKillTimer = v; },
    };
    DEPS.set(host, d);
  }
  return d;
}

module.exports = {
  methods: {
  _mainOwnerFile() {
    const d = depsOf(this);
    try { return path.join(path.dirname(d.config().stateFile), 'dsh-main.owner.json'); } catch { return null; }
  },

  _readMainOwner() {
    const d = depsOf(this);
    try {
      const p = d.mainOwnerFile();
      if (!p) return null;
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      return (j && typeof j === 'object' && j.dshPid) ? j : null;
    } catch { return null; }
  },

  
  _writeMainOwner(dshPid, port) {
    const d = depsOf(this);
    try {
      const p = d.mainOwnerFile();
      if (!p || !dshPid) return;
      writeAtomic(p, JSON.stringify({
        guardPid: process.pid, dshPid, port: port || null, startedAt: Date.now(),
      }), { mode: 0o600 });
    } catch (e) {
      d.logger() && d.logger().warn && d.logger().warn('writeMainOwner: ' + ((e && e.message) || e));
    }
  },

  _isManagedProcess(pid) {
    const d = depsOf(this);
    const own = d.readMainOwner();
    if (own && own.dshPid === pid && own.guardPid && own.guardPid !== process.pid
        && pidlook.isAlive && pidlook.isAlive(own.guardPid)) {
      d.logger() && d.logger().warn && d.logger().warn(
        'refuse adopt pid=' + pid + '：归属凭据指向另一存活守卫 pid=' + own.guardPid + '（不双管家互杀）');
      return false;
    }
    const cmd = pidlook.readCmdline(pid);
    if (!cmd) return false;
    const bin = d.config().command && d.config().command[1];
    if (typeof bin === 'string' && bin && cmd.includes(bin)) return true;
    return /(^|\s)web(\s|$)/.test(cmd) && pidlook.isDshCmdline(pid);
  },

  _signalChild(child, sig) {
    platform.processControl.signalProcess(child.pid, sig);
  },

  _killTree(child, sig) {
    const d = depsOf(this);
    const pc = platform.processControl;
    if (pc && typeof pc.killTree === 'function') {
      pc.killTree(child.pid, sig || 'SIGKILL', () => {}, { ownGroup: true });
      return;
    }
    d.signalChild(child, sig || 'SIGKILL');
  },

  _killSequence(child) {
    const d = depsOf(this);
    d.events().append('sigterm_sent', { pid: child.pid });
    d.signalChild(child, 'SIGTERM');
    d.writeKillTimer(setTimeout(() => {
      d.writeKillTimer(null);
      if (child.exitCode === null && child.signalCode === null) {
        d.killTree(child, 'SIGKILL');
        d.events().append('sigkill_sent', { pid: child.pid, tree: platform.PLATFORM === 'win32' });
      }
    }, d.config().stopGraceMs));
  },

    
  _killAdopted(pid) {
    const d = depsOf(this);
    const gen = (d.readAdoptKillGen() || 0) + 1;
    d.writeAdoptKillGen(gen);
    const releaseSlot = () => { if (gen === d.readAdoptKillGen()) d.writeAdoptKillTimer(null); };
    d.events().append('sigterm_sent', { pid, adopted: true });
    try {
      process.kill(pid, 'SIGTERM');
    } catch {}
    d.writeAdoptKillTimer(setTimeout(() => {
      releaseSlot();
      if (pidlook.isAlive(pid)) {
                
        const pc = platform.processControl;
        if (pc && typeof pc.killTree === 'function') {
          pc.killTree(pid, 'SIGKILL', () => {});
        } else {
          try { process.kill(pid, 'SIGKILL'); } catch {}
        }
        d.events().append('sigkill_sent', { pid, adopted: true, tree: platform.PLATFORM === 'win32' });
        const verify = setTimeout(() => {
          releaseSlot();
          if (!pidlook.isAlive(pid)) return;
          d.events().append('stop_failed', { pid, adopted: true, reason: 'SIGKILL 后仍存活' });
          if (d.logger() && d.logger().warn) {
            d.logger().warn('[main] 接管实例停止落空：pid ' + pid + ' 在 SIGKILL 后仍存活');
          }
        }, ADOPT_KILL_VERIFY_MS);
        if (verify && typeof verify.unref === 'function') verify.unref();
        d.writeAdoptKillTimer(verify);
      }
    }, d.config().stopGraceMs));
  }
  },
};
