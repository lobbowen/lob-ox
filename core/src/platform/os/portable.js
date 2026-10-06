'use strict';

const fs = require('node:fs');
const pidlookup = require('./pidlookup');
const spawner = require('./spawn');
const procOS = require('./process');

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
  return anchors.some((a) => a && cmd.indexOf(String(a)) !== -1);
}

const portOf = (o) => { const p = Number(o && o.port); return Number.isInteger(p) && p > 0 ? p : 0; };
const pidFileOf = (o) => (o && o.pidFile) || null;
const anchorsOf = (o) => (Array.isArray(o && o.anchors) ? o.anchors : []);

// run.pid 命中即本方 detached 拉起 → ownGroup=true 可整树；仅端口锚点命中的监听者来路不明 → 只发单进程信号。
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

const portable = {
  kind: 'portable',
  supportsUnits: false,
  supportsTransient: true,

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
    // 无监听器的 'error' 会二次抛出打挂守卫：spawn 异步失败在此吞掉，由监督拍按「端口 30s 未监听」判失败退避。
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
    if (findOurs(opts)) return true;
    const port = portOf(opts);
    const pidFile = pidFileOf(opts);
    const anchors = anchorsOf(opts);
    if (!port && !pidFile) return null;
    if (!anchors.length) {
      const fp = readPidFile(pidFile);
      if (fp !== null && pidlookup.isAlive(fp)) return true;
      if (port) {
        const q = pidlookup.findListeningPid(port);
        if (q !== null) return true;
        if (fp !== null) return false;
        return null;
      }
      return fp !== null ? false : null;
    }
    const fp = readPidFile(pidFile);
    if (fp !== null && pidlookup.isAlive(fp) && !pidlookup.readCmdline(fp)) return null;
    return false;
  },

  transientUnitFile() { return null; },

  cleanTransient(unit, o) {
    const opts = o || {};
    const errors = [];
    if (this.stopUnit(unit, Object.assign({}, opts, { timeoutMs: 1500 })) === false) errors.push('stop-unconfirmed');
    removePidFile(opts);
    return { ok: errors.length === 0, errors };
  },

  setLimits() { return false; },
};

module.exports = { portable, findOurs, matchesAnchors, _test: { readPidFile, matchesAnchors, findOurs } };
