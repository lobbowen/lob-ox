'use strict';

const fs = require('node:fs');
const pidlookup = require('./pidlookup');
const spawner = require('./spawn');
const procOS = require('./process');
const OUTCOME = require('../../shared/outcome');

const STOP_WAIT_CAP_MS = 3000;
const NAP_MS = 150;

function nap(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch {  }
}

function readPidFile(pidFile) {
  if (!pidFile) return null;
  try {
    const n = parseInt(String(fs.readFileSync(pidFile, 'utf8')).trim(), 10);
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch { return null; }
}

function matchesAnchors(pid, anchors) {
  if (!pid || !Array.isArray(anchors) || !anchors.length) return false;
  const cmd = pidlookup.readCmdline(pid);
  if (!cmd) return false;
  return anchors.every((a) => a && cmd.indexOf(String(a)) !== -1);
}

const portOf = (o) => { const p = Number(o && o.port); return Number.isInteger(p) && p > 0 ? p : 0; };
const pidFileOf = (o) => (o && o.pidFile) || null;
const anchorsOf = (o) => (Array.isArray(o && o.anchors) ? o.anchors : []);


function findOurs(o) {
  const anchors = anchorsOf(o);
  const fp = readPidFile(pidFileOf(o));
  if (fp !== null && pidlookup.isAlive(fp) && matchesAnchors(fp, anchors)) return { pid: fp, ownGroup: true };
  const port = portOf(o);
  if (port) {
    const q = pidlookup.findListeningPid(port);
    if (q !== null && q !== fp && matchesAnchors(q, anchors)) return { pid: q, ownGroup: false };
  }
  return null;
}

function removePidFile(o) {
  const f = pidFileOf(o);
  if (f) { try { fs.unlinkSync(f); } catch {  } }
}



function aliveOutcome(pid) {
  if (typeof pidlookup.outcomeAlive === 'function') return pidlookup.outcomeAlive(pid);
  if (typeof pidlookup.probeAlive === 'function') {
    const st = pidlookup.probeAlive(pid);
    if (st === 'alive') return OUTCOME.OK;
    if (st === 'dead') return OUTCOME.fail('pid ' + pid + ' 已退出');
    return OUTCOME.UNKNOWN;
  }
  const a = !!pidlookup.isAlive(pid);
  return a ? OUTCOME.OK : OUTCOME.fail('pid ' + pid + ' 已退出');
}

const portable = {
  kind: 'portable',
  supportsUnits: false,
  supportsTransient: true,

  
  supports(cap) {
    if (cap === 'treeKill') return true;              
    if (cap === 'limits') return false;               
    if (cap === 'unit') return false;                 
    return false;
  },

  daemonReload() { return true; },
  resetFailed() { return true; },

  startTransient(o) {
    const opts = o || {};
    const cmd = opts.cmd || [];
    if (!cmd.length) throw new Error('portable 拉起拒绝：空命令');
    const child = spawner.detached(cmd[0], cmd.slice(1), {
      cwd: opts.workingDir || undefined,
      env: Object.assign({}, process.env, opts.env || {}),
    });
    
    child.on('error', () => {});
    if (!child.pid) {
      try { child.kill(); } catch {  }
      throw new Error('portable 拉起失败：spawn 未产生进程');
    }
    try { child.unref(); } catch {  }
    if (opts.pidFile) {
      try { fs.writeFileSync(opts.pidFile, String(child.pid)); } catch {  }
    }
    return true;
  },

  
  
  
  
  
  async stopUnit(unit, o) {
    const opts = o || {};
    const ours = findOurs(opts);
    if (!ours) { removePidFile(opts); return true; }
    try { procOS.killTree(ours.pid, 'SIGTERM', undefined, { ownGroup: ours.ownGroup }); }
    catch {  }
    const budget = Math.max(0, Math.min(typeof opts.timeoutMs === 'number' ? opts.timeoutMs : STOP_WAIT_CAP_MS, STOP_WAIT_CAP_MS));
    const t0 = Date.now();
    while (Date.now() - t0 < budget) {
      if (!findOurs(opts)) { removePidFile(opts); return true; }
      await new Promise((r) => setTimeout(r, NAP_MS));
    }
    
    try {
      await new Promise((resolve) => {
        let done = false;
        procOS.killTree(ours.pid, 'SIGKILL', () => { done = true; resolve(true); }, { ownGroup: ours.ownGroup });
        setTimeout(() => { if (!done) resolve(false); }, 10000);
      });
    } catch {  }
    if (!findOurs(opts)) { removePidFile(opts); return true; }
    return false;
  },

  daemonReload() { return true; },
  resetFailed() { return true; },

  startTransient(o) {
    const opts = o || {};
    const cmd = opts.cmd || [];
    if (!cmd.length) throw new Error('portable 拉起拒绝：空命令');
    const child = spawner.detached(cmd[0], cmd.slice(1), {
      cwd: opts.workingDir || undefined,
      env: Object.assign({}, process.env, opts.env || {}),
    });
    
    child.on('error', () => {});
    if (!child.pid) {
      try { child.kill(); } catch {  }
      throw new Error('portable 拉起失败：spawn 未产生进程');
    }
    try { child.unref(); } catch {  }
    if (opts.pidFile) {
      try { fs.writeFileSync(opts.pidFile, String(child.pid)); } catch {  }
    }
    return true;
  },

  stopUnit(unit, o) {
    const opts = o || {};
    const ours = findOurs(opts);
    if (!ours) { removePidFile(opts); return true; }
    try { procOS.killTree(ours.pid, 'SIGTERM', undefined, { ownGroup: ours.ownGroup }); }
    catch {  }
    const budget = Math.max(0, Math.min(typeof opts.timeoutMs === 'number' ? opts.timeoutMs : STOP_WAIT_CAP_MS, STOP_WAIT_CAP_MS));
    const t0 = Date.now();
    for (;;) {
      if (!findOurs(opts)) { removePidFile(opts); return true; }
      if (Date.now() - t0 >= budget) break;
      nap(NAP_MS);
    }
    try { procOS.killTree(ours.pid, 'SIGKILL', undefined, { ownGroup: ours.ownGroup }); } catch {  }
    nap(NAP_MS);
    if (!findOurs(opts)) { removePidFile(opts); return true; }
    return false;
  },

  
  isUnitActive(unit, o) {
    const opts = o || {};
    if (findOurs(opts)) return OUTCOME.OK;
    const port = portOf(opts);
    const pidFile = pidFileOf(opts);
    const anchors = anchorsOf(opts);
    if (!port && !pidFile) return OUTCOME.UNKNOWN;
    const fp = readPidFile(pidFile);
    
    
    
    
    if (!pidFile) return OUTCOME.UNKNOWN;
    if (fp === null || fp === undefined) return OUTCOME.fail('pid 文件不存在（无进程在跑）');
    if (!anchors.length) {
      
      return aliveOutcome(fp);
    }
    
    const st2 = aliveOutcome(fp);
    if (OUTCOME.isFail(st2)) return st2;
    if (OUTCOME.isUnknown(st2)) return st2;
    const cmd = pidlookup.readCmdline(fp);
    if (!cmd) return OUTCOME.UNKNOWN;           
    return matchesAnchors(fp, anchors) ? OUTCOME.OK : OUTCOME.UNKNOWN;
  },

  transientUnitFile() { return null; },

  
  async cleanTransient(unit, o) {
    const opts = o || {};
    const errors = [];
    if ((await this.stopUnit(unit, Object.assign({}, opts, { timeoutMs: 1500 }))) === false) errors.push('stop-unconfirmed');
    removePidFile(opts);
    return { ok: errors.length === 0, errors };
  },

  setLimits() { return false; },
};

module.exports = { portable, findOurs, matchesAnchors, _test: { readPidFile, matchesAnchors, findOurs } };
