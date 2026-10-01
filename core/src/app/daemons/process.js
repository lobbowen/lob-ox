'use strict';

const spawnOS = require('../../platform/os/spawn');

const fs = require('node:fs');
const path = require('node:path');
const pidlook = require('../../platform/os/pidlookup');
const { writeAtomic } = require('../../platform/util/fs');
const { waitProcessExit, waitPortFree } = require('./process-wait');
const { deriveCmdMarks } = require('./process-marks');

class DaemonLifecycle {
  constructor(o) {
    this.name = o.name;
    this.script = o.script;
    this.args = o.args || [];
    this.ctlPort = o.ctlPort;
    this.cmdMark = o.cmdMark;
    this._cmdMarks = deriveCmdMarks(this.script, o.cmdMark);
    this.identityFile = o.identityFile;
    this.spawnEnv = o.spawnEnv || (() => ({}));
    this.logger = o.logger || console;
    this.events = o.events || null;
    this.readyTimeoutMs = o.readyTimeoutMs || 10000;
    this.stopGraceMs = o.stopGraceMs || 4000;
    this.portReleaseTimeoutMs = o.portReleaseTimeoutMs || 5000;
    this.spawnWindowMs = o.spawnWindowMs || 25000;
    this._exitIntended = typeof o.exitIntended === 'function' ? o.exitIntended : () => false;
    this._spawnWindowUntil = 0;
    this._stopping = false;
  }

  _readIdentity() {
    try { return JSON.parse(fs.readFileSync(this.identityFile, 'utf8')); } catch { return null; }
  }
  _writeIdentity(daemonPid) {
    try {
      const dir = path.dirname(this.identityFile);
      try { fs.mkdirSync(dir, { recursive: true }); } catch {}
      writeAtomic(this.identityFile, JSON.stringify({ guardPid: process.pid, daemonPid, startedAt: Date.now() }), { mode: 0o600 });
    } catch (e) {
      if (this.logger && this.logger.warn) this.logger.warn(this.name + ' identity write failed: ' + ((e && e.message) || e));
      try { if (this.events && this.events.append) this.events.append('daemon_identity_write_error', { name: this.name, pid: daemonPid, error: (e && e.message) || String(e) }); } catch {}
    }
  }
  _clearIdentity() { try { fs.unlinkSync(this.identityFile); } catch {} }

  _pidAlive(pid) {
    if (!pid) return false;
    const st = pidlook.probeAlive(pid);
    if (st === 'alive') return true;
    if (st === 'dead') return false;
    return this._ctlOwnerPid() === pid;
  }

  _ctlOwnerPid() {
    try {
      const pid = pidlook.findListeningPid(this.ctlPort);
      if (!pid) return null;
      const cmd = pidlook.normCmdline(pidlook.readCmdline(pid) || '');
      return this._cmdMarks.some((mk) => mk && cmd.indexOf(mk) >= 0) ? pid : null;
    } catch { return null; }
  }

  expectedPid() { const id = this._readIdentity(); return id && id.daemonPid ? id.daemonPid : null; }

  reclaimOrphans() {
    const args = this.args || [];
    let cfg = '';
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '-c' || args[i] === '--config') { cfg = String(args[i + 1] || ''); break; }
    }
    const marks = this._cmdMarks.length ? this._cmdMarks : [this.cmdMark];
    const seen = new Set();
    const candidates = [];
    for (const mk of marks) {
      if (!mk) continue;
      let list = [];
      try { list = pidlook.pgrepList(mk) || []; } catch { list = []; }
      for (const m of list) { if (m && !seen.has(m.pid)) { seen.add(m.pid); candidates.push(m); } }
    }
    let killed = 0;
    try {
      const mine = this.expectedPid();
      const ctlOwner = this._ctlOwnerPid();
      for (const m of candidates) {
        const pid = m.pid;
        const cmd = m.cmdline;
        if (pid === process.pid) continue;
        if (pid === mine) continue;
        if (pid === ctlOwner) continue;
        if (cfg && cmd.indexOf(cfg) < 0) continue;
        try { process.kill(pid, 'SIGTERM'); killed++; this.logger.warn && this.logger.warn('[' + this.name + '] 回收旧代孤儿 pid=' + pid + ' ' + cmd.slice(0, 90)); } catch {}
      }
    } catch (e) {  }
    return killed;
  }

  ensureRunning() {
    if (this._stopping) return { mode: 'stopping' };
    try { this.reclaimOrphans(); } catch {}
    const exp = this.expectedPid();
    if (exp && this._pidAlive(exp)) {
      return { mode: 'adopted', pid: exp };
    }
    if (Date.now() < this._spawnWindowUntil) return { mode: 'barrier' };
    const stale = this._ctlOwnerPid();
    if (stale) {
      this._stopPid(stale);
      this._spawnWindowUntil = Date.now() + 3000;
      this.logger.warn && this.logger.warn('[' + this.name + '] 换代：旧代 pid=' + stale + ' 仍在 ' + this.ctlPort + '，已 TERM，稍后启新');
      return { mode: 'reclaiming', stale };
    }
    return this._spawn();
  }

  _stopPid(pid) {
    try { process.kill(pid, 'SIGTERM'); } catch {}
    setTimeout(() => { try { process.kill(pid, 'SIGKILL'); } catch {} }, this.stopGraceMs).unref();
  }

  _spawn() {
    if (this._stopping || this._exitIntended()) return { mode: 'stopping' };
    const child = spawnOS.detached(process.execPath, [this.script, ...this.args], {
      stdio: 'ignore', env: { ...process.env, ...(this.spawnEnv() || {}) },
    });
    child.on('error', (e) => {
      if (this.logger && this.logger.warn) this.logger.warn('[' + this.name + '] daemon spawn error: ' + ((e && e.message) || e));
      try { if (this.events && this.events.append) this.events.append('daemon_spawn_error', { name: this.name, error: (e && e.message) || String(e), script: this.script }); } catch {}
    });
    child.unref();
    this._spawnWindowUntil = Date.now() + this.spawnWindowMs;
    if (!child.pid) {
      this.logger.warn && this.logger.warn('[' + this.name + '] daemon 未启动（' + this.script + ' 不存在或不可执行）');
      return { mode: 'failed', error: 'daemon 未启动（脚本不可执行或 Node 不可用）', script: this.script };
    }
    this._writeIdentity(child.pid);
    if (this.logger && this.logger.info) this.logger.info('[' + this.name + '] 已拉起独立 daemon pid=' + child.pid + '（spawn 窗口至 ' + new Date(this._spawnWindowUntil).toISOString() + '）');
    return { mode: 'started', pid: child.pid };
  }

  classify() {
    if (this._stopping) return { mode: 'stopping' };
    const exp = this.expectedPid();
    if (exp && this._pidAlive(exp)) {
      const owner = this._ctlOwnerPid();
      if (owner && owner !== exp) return { mode: 'external', owner, pid: exp };
      return { mode: 'running', pid: exp };
    }
    if (Date.now() < this._spawnWindowUntil) return { mode: 'barrier' };
    const stale = this._ctlOwnerPid();
    if (stale) return { mode: 'reclaiming', stale };
    return { mode: 'absent' };
  }

  async superviseOnce() {
    if (!this.expectedPid()) { try { this.reclaimOrphans(); } catch {} }
    const c = this.classify();
    if (c.mode === 'running' || c.mode === 'external' || c.mode === 'barrier' || c.mode === 'stopping') return c;
    if (c.mode === 'reclaiming') {
      this._stopPid(c.stale);
      this._spawnWindowUntil = Date.now() + 3000;
      return c;
    }
    return this._spawn();
  }

  async stop() {
    this._stopping = true;
    const exp = this.expectedPid();
    let stopped = null;
    if (exp && this._pidAlive(exp)) { this._stopPid(exp); stopped = exp; }
    else {
      const owner = this._ctlOwnerPid();
      if (owner) { this._stopPid(owner); stopped = owner; }
    }
    let dead = true;
    if (stopped) {
      dead = await waitProcessExit(stopped, this.stopGraceMs + 1500);
      if (!dead) this.logger.warn && this.logger.warn('[' + this.name + '] 停止超时 pid=' + stopped);
    }
    const portFree = await waitPortFree(this.ctlPort, this.portReleaseTimeoutMs);
    if (!portFree) this.logger.warn && this.logger.warn('[' + this.name + '] 停止后端口 ' + this.ctlPort + ' 未释放');
    this._stopping = false;
    this._spawnWindowUntil = 0;
    if (!dead) {
      try { if (this.events && this.events.append) this.events.append('daemon_stop_timeout', { name: this.name, pid: stopped, port: this.ctlPort }); } catch {}
      return { ok: false, stopped, error: 'daemon 未在超时内退出（pid=' + stopped + ' 可能已忽略 SIGTERM）', portFree };
    }
    this._clearIdentity();
    return { ok: true, stopped, portFree };
  }

  status() {
    const id = this._readIdentity();
    const exp = (id && id.daemonPid) || null;
    return {
      name: this.name,
      pid: exp,
      alive: exp ? this._pidAlive(exp) : false,
      ctlUp: !!this._ctlOwnerPid(),
      since: (id && id.startedAt) || null,
      guardPid: (id && id.guardPid) || null,
      spawnWindow: this._spawnWindowUntil > Date.now(),
    };
  }
}

module.exports = { DaemonLifecycle };
