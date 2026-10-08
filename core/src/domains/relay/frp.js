'use strict';

const platform = require('../../platform/os/index');
const pidlook = require('../../platform/os/pidlookup');

const fs = require('node:fs');
const path = require('node:path');
const spawnOS = require('../../platform/os/spawn');
const { writeAtomic } = require('../../platform/util/fs');
const { buildFrpcToml, validateFrpServerSettings } = require('./core');
const { frpPlatformTag, download, installFrpc } = require('./frp-install');

class FrpManager {
  constructor(opts) {
    this.dir = opts.dir;
    this.logger = opts.logger || console;
    this.events = opts.events || null;
    this.settingsFile = path.join(this.dir, 'frp.json');
    this.configFile = path.join(this.dir, 'frpc.toml');
    this.binDir = path.join(this.dir, 'bin');
    const tag = frpPlatformTag();
    this.frpTag = tag;
    this.binPath = path.join(this.binDir, tag ? (tag.exe ? 'frpc.exe' : 'frpc') : 'frpc');
    this.child = null;
    this.logTail = [];
    this._lastCount = 0;
    this._restartTimer = null;
    this._restartAttempts = 0;
    this._intentionalStop = false;
    this._sumCache = null;
    this._hardenPermissions();
  }

  _hardenPermissions() {
    try {
      const fp = platform.fileProtect;
      for (const f of [this.settingsFile, this.configFile]) {
        try { if (fs.existsSync(f)) fp.protectFile(f); } catch {}
      }
    } catch {  }
  }

  loadSettings() {
    try {
      const s = JSON.parse(fs.readFileSync(this.settingsFile, 'utf8'));
      return {
        serverAddr: String(s.serverAddr || ''),
        serverPort: Number(s.serverPort) || 7000,
        authToken: String(s.authToken || ''),
        user: String(s.user || 'dsh'),
      };
    } catch {}
    return { serverAddr: '', serverPort: 7000, authToken: '', user: 'dsh' };
  }

  saveSettings(s) {
    fs.mkdirSync(this.dir, { recursive: true });
    writeAtomic(this.settingsFile, JSON.stringify(s, null, 2), { mode: 0o600 });
  }

  status() {
    const s = this.loadSettings();
    return {
      installed: fs.existsSync(this.binPath),
      running: !!(this.child && this.child.pid),
      pid: this.child ? this.child.pid : null,
      settings: { serverAddr: s.serverAddr, serverPort: s.serverPort, user: s.user, authTokenSet: !!s.authToken },
      logTail: this.logTail.slice(-20),
    };
  }

  buildConfig(settings, instances) {
    return buildFrpcToml(settings, instances);
  }

  syncFromInstances(instances) {
    const settings = this.loadSettings();
    const { text, count } = this.buildConfig(settings, instances);
    fs.mkdirSync(this.dir, { recursive: true });
    // RL-8：审计指出本函数每次调用都无条件重写并重启 frpc，导致「改动一个 lan 实例 ⇒ 所有 WAN 隧道全断」。
    // 修法：先比对现有 frpc.toml 字节；字节相同则**只更新 _lastCount、不重写不重启**（无 diff 不动进程）。
    // 仅在首次生成、或字节确实不同（真有 wan 实例/令牌/服务器变更）时才重写 + 重启。
    let unchanged = false;
    try {
      if (fs.existsSync(this.configFile)) {
        const prev = fs.readFileSync(this.configFile, 'utf8');
        unchanged = prev === text;
      }
    } catch {}
    if (!unchanged) {
      // frpc.toml / frp.json 含 auth.token 明文：新写入 0600，启动时补加固旧文件。
      writeAtomic(this.configFile, text, { mode: 0o600 });
    }
    this._lastCount = count;
    if (count === 0) {
      if (!unchanged) this.stop();
      return { ok: true, proxies: count, running: false };
    }
    if (!fs.existsSync(this.binPath)) {
      return { ok: false, error: 'frpc not installed', needInstall: true, proxies: count };
    }
    if (unchanged) return { ok: true, proxies: count, running: !!this.child, unchanged: true };
    return this.restart();
  }

  restart() {
    this.stop();
    return this.start();
  }

  start() {
    if (this.child && this.child.pid) return { ok: true, already: true, pid: this.child.pid };
    const vs = validateFrpServerSettings(this.loadSettings());
    if (!vs.ok) return { ok: false, error: vs.error, needServerAddr: true };
    this._intentionalStop = false;
    if (this._stableTimer) clearTimeout(this._stableTimer);
    this._stableTimer = setTimeout(() => { this._restartAttempts = 0; }, 60000);
    if (this._stableTimer.unref) this._stableTimer.unref();
    this._cleanupOrphans();
    if (!fs.existsSync(this.binPath)) return { ok: false, error: 'frpc binary missing', needInstall: true };
    try { fs.accessSync(this.configFile, fs.constants.R_OK); } catch { return { ok: false, error: 'no config generated yet' }; }
    let child;
    try {
      child = spawnOS.piped(this.binPath, ['-c', this.configFile]);
    } catch (e) {
      if (this._stableTimer) clearTimeout(this._stableTimer);
      return { ok: false, error: 'frpc spawn failed: ' + ((e && e.message) || e), needInstall: true };
    }
    this.child = child;
    const pushLog = (line) => {
      line = String(line).trim();
      if (!line) return;
      this.logTail.push(new Date().toISOString().slice(11, 19) + ' ' + line);
      if (this.logTail.length > 200) this.logTail.splice(0, this.logTail.length - 200);
    };
    child.on('error', (e) => {
      pushLog('[spawn error] ' + ((e && e.message) || e));
      if (this.child !== child) return;
      this.child = null;
      if (!this._intentionalStop) this._scheduleRestart();
    });
    child.stdout.on('data', (c) => String(c).split('\n').forEach(pushLog));
    child.stderr.on('data', (c) => String(c).split('\n').forEach(pushLog));
    child.on('exit', (code) => {
      pushLog('[exited code=' + code + ']');
      if (this.child !== child) return;
      this.child = null;
      // 兜底重启：非主动 stop 且配置仍应运行才按退避重拉（最多 5 次，封顶 60s）。
      if (!this._intentionalStop) this._scheduleRestart();
    });
    if (this.events) this.events.append('frpc_started', { pid: child.pid });
    this.logger.info && this.logger.info('frpc started pid=' + child.pid);
    return { ok: true, pid: child.pid };
  }

  _scheduleRestart() {
    if (this._restartTimer) return;
    if (!this._lastCount) return;
    if (this._restartAttempts >= 5) {
      if (this.events) this.events.append('frpc_restart_gaveup', { attempts: this._restartAttempts });
      this.logger.warn && this.logger.warn('[frpc] 连续重启 ' + this._restartAttempts + ' 次仍失败，停止重试（等待下次配置变更触发）');
      return;
    }
    const delay = Math.min(60000, 2000 * Math.pow(2, this._restartAttempts));
    this._restartAttempts += 1;
    this._restartTimer = setTimeout(() => {
      this._restartTimer = null;
      this.logger.warn && this.logger.warn('[frpc] 非预期退出 → ' + Math.round(delay / 1000) + 's 后重启（第 ' + this._restartAttempts + ' 次）');
      try { this.start(); } catch (e) { this.logger.warn && this.logger.warn('[frpc] 重启失败: ' + (e && e.message)); }
    }, delay);
    if (this._restartTimer.unref) this._restartTimer.unref();
  }

  stop() {
    this._intentionalStop = true;
    if (this._restartTimer) { clearTimeout(this._restartTimer); this._restartTimer = null; }
    if (!this.child) {
      const killed = this._cleanupOrphans();
      if (killed > 0 && this.events) this.events.append('frpc_stopped', {});
      return { ok: true, already: true };
    }
    const c = this.child;
    this.child = null;
    try { c.kill('SIGTERM'); } catch {}
    const start = Date.now();
    const guard = setInterval(() => {
      if (c.exitCode !== null) { clearInterval(guard); return; }
      if (Date.now() - start > 3000) {
        clearInterval(guard);
        try { c.kill('SIGKILL'); } catch {}
      }
    }, 250);
    if (this.events) this.events.append('frpc_stopped', {});
    return { ok: true };
  }

  _findProcessesByCmd(pat) {
    try {
      return pidlook.pgrepList(pat).map((m) => ({ pid: m.pid, cmdline: m.cmdline }));
    } catch { return []; }
  }

  _cleanupOrphans() {
    let killed = 0;
    const procs = this._findProcessesByCmd('frpc');
    for (const p of procs) {
      if (!String(p.cmdline || '').includes(this.configFile)) continue;
      if (p.pid === process.pid) continue;
      try { process.kill(p.pid, 'SIGTERM'); killed++; } catch {}
      if (this.logger && this.logger.warn) this.logger.warn('killed orphan frpc pid=' + p.pid);
    }
    return killed;
  }

  _download(url, report) {
    return download(url, report);
  }

  async install(onProgress) {
    const cache = this._sumCache || (this._sumCache = {});
    return installFrpc({
      binDir: this.binDir,
      binPath: this.binPath,
      frpTag: this.frpTag,
      logger: this.logger,
      events: this.events,
      sumCache: cache,
      download: (url, report) => this._download(url, report),
    }, onProgress);
  }
}

module.exports = { FrpManager };
