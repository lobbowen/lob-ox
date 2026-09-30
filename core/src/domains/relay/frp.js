'use strict';

const platform = require('../../platform/os/index');
const pidlook = require('../../platform/os/pidlookup');

// frpc 进程托管 + settings 持久化 + status + syncFromInstances（安装/校验/解压在 frp-install.js）。
// frpc.toml 由受管清单里 remoteMode==='wan' 的实例生成；生命周期单一条件 = 是否存在 wan 隧道，无全局总闸。

const fs = require('node:fs');
const path = require('node:path');
// SSOT：异步 spawn 统一封装（固定 windowsHide:true）；需读 frpc 输出，故用 piped。
const spawnOS = require('../../platform/os/spawn');
const { writeAtomic } = require('../../platform/util/fs');
const { buildFrpcToml, validateFrpServerSettings } = require('./core');
const { frpPlatformTag, download, installFrpc } = require('./frp-install');

class FrpManager {
  constructor(opts) {
    this.dir = opts.dir;               // 守卫状态目录（默认 <产品状态根>/supervisor）
    this.logger = opts.logger || console;
    this.events = opts.events || null;
    this.settingsFile = path.join(this.dir, 'frp.json');
    this.configFile = path.join(this.dir, 'frpc.toml');
    this.binDir = path.join(this.dir, 'bin');
    const tag = frpPlatformTag();
    this.frpTag = tag; // null = 当前平台无 frpc 官方产物（如 32 位）
    this.binPath = path.join(this.binDir, tag ? (tag.exe ? 'frpc.exe' : 'frpc') : 'frpc');
    this.child = null;
    this.logTail = [];
    // 兜底重启：frpc 非预期退出（崩溃/配置错误/OOM）时自动重拉。
    this._lastCount = 0;      // 最近一次生成的 [[proxies]] 数（决定是否值得重启）
    this._restartTimer = null;
    this._restartAttempts = 0;
    this._intentionalStop = false;
    this._sumCache = null;     // 官方校验和缓存（按 asset）
    this._hardenPermissions();
  }

  /** frpc.toml 含 auth.token 明文、frp.json 同含 token：新写入已用 0600，
   *  但历史遗留文件可能是早期以默认 umask 写出的 0644/0664，故启动时补加固。 */
  _hardenPermissions() {
    try {
      const fp = platform.fileProtect;
      for (const f of [this.settingsFile, this.configFile]) {
        try { if (fs.existsSync(f)) fp.protectFile(f); } catch {}
      }
    } catch { /* 平台层不可用时忽略（不阻断 frp 功能） */ }
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
    // frp.json 含 authToken 明文：tmp 带 pid（防并发互踩/预测名劫持）且以 0600 建立，与 frpc.toml 同规。
    writeAtomic(this.settingsFile, JSON.stringify(s, null, 2), { mode: 0o600 });
  }

  status() {
    const s = this.loadSettings();
    return {
      installed: fs.existsSync(this.binPath),
      running: !!(this.child && this.child.pid),
      pid: this.child ? this.child.pid : null,
      // API 面绝不回显 authToken 明文，只报 authTokenSet（与 access.js「只报 configured」同规）。
      // normalizeFrpSettings 是 patch 归并：字段缺省（undefined）= 保留现值，显式 '' = 清除；
      // 故 UI 想保留现值必须省略字段而不是留空。
      settings: { serverAddr: s.serverAddr, serverPort: s.serverPort, user: s.user, authTokenSet: !!s.authToken },
      logTail: this.logTail.slice(-20),
    };
  }

  /** wan 实例映射为远程端口；文本生成委托纯函数 core.buildFrpcToml。 */
  buildConfig(settings, instances) {
    return buildFrpcToml(settings, instances);
  }

  /** 受管清单变化时调用：重写配置，运行中则平滑重启（生命周期条件见类头：是否存在 wan 隧道）。 */
  syncFromInstances(instances) {
    const settings = this.loadSettings();
    const { text, count } = this.buildConfig(settings, instances);
    fs.mkdirSync(this.dir, { recursive: true });
    // frpc.toml 含 auth.token 明文：与 frp.json 同级 0600。
    writeAtomic(this.configFile, text, { mode: 0o600 });
    this._lastCount = count; // 供兜底重启判定「是否还有代理值得拉起」
    if (count === 0) {
      this.stop();
      return { ok: true, proxies: count, running: false };
    }
    if (!fs.existsSync(this.binPath)) {
      return { ok: false, error: 'frpc not installed', needInstall: true, proxies: count };
    }
    return this.restart();
  }

  restart() {
    this.stop();
    return this.start();
  }

  start() {
    if (this.child && this.child.pid) return { ok: true, already: true, pid: this.child.pid };
    // 执行边界复校：serverAddr 为空即不允许 spawn frpc，不论配置由谁写出。
    const vs = validateFrpServerSettings(this.loadSettings());
    if (!vs.ok) return { ok: false, error: vs.error, needServerAddr: true };
    this._intentionalStop = false; // 显式启动：清除主动停止标记
    // 稳定运行 60s 后重置重试计数。
    if (this._stableTimer) clearTimeout(this._stableTimer);
    this._stableTimer = setTimeout(() => { this._restartAttempts = 0; }, 60000);
    if (this._stableTimer.unref) this._stableTimer.unref();
    // 先清理守卫重启后可能残留的孤儿 frpc（防双实例注册同名代理）。
    this._cleanupOrphans();
    if (!fs.existsSync(this.binPath)) return { ok: false, error: 'frpc binary missing', needInstall: true };
    try { fs.accessSync(this.configFile, fs.constants.R_OK); } catch { return { ok: false, error: 'no config generated yet' }; }
    // spawn 可能同步抛出（binPath 不是可执行格式），必须降级为返回值而非崩溃进程。
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
    // 必须监听 'error'：二进制存在但不可执行时 Node 会异步 emit 'error'，无监听器即未捕获异常。
    child.on('error', (e) => {
      pushLog('[spawn error] ' + ((e && e.message) || e));
      // 所有权守卫：只有仍是当前子进程时，其事件才可影响状态与重启排期。已换新进程时，旧进程
      // 迟到的 error/exit 若仍排期重启会毒化重试计数，让真实崩溃不再自愈。
      if (this.child !== child) return;
      this.child = null;
      if (!this._intentionalStop) this._scheduleRestart();
    });
    child.stdout.on('data', (c) => String(c).split('\n').forEach(pushLog));
    child.stderr.on('data', (c) => String(c).split('\n').forEach(pushLog));
    child.on('exit', (code) => {
      pushLog('[exited code=' + code + ']');
      if (this.child !== child) return; // 陈旧子进程（已被新进程取代）的退出不得触发重启
      this.child = null;
      // 兜底重启：非主动 stop、且配置仍应运行时，按退避重拉（最多 5 次，封顶 60s）。
      if (!this._intentionalStop) this._scheduleRestart();
    });
    if (this.events) this.events.append('frpc_started', { pid: child.pid });
    this.logger.info && this.logger.info('frpc started pid=' + child.pid);
    return { ok: true, pid: child.pid };
  }

  _scheduleRestart() {
    if (this._restartTimer) return;
    if (!this._lastCount) return; // 已无代理应运行：不重启
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
      // 本守卫无句柄：可能是守卫重启产生的孤儿 frpc，按配置特征清理。
      const killed = this._cleanupOrphans();
      if (killed > 0 && this.events) this.events.append('frpc_stopped', {});
      return { ok: true, already: true };
    }
    const c = this.child;
    this.child = null;
    try { c.kill('SIGTERM'); } catch {}
    // SIGKILL 兜底必须用 exitCode 判定：child.killed 在 kill() 后立即为 true（表示已发信号而非已退出）。
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

  /** 跨平台「按 cmdline 特征找进程」：统一走平台层 pidlookup.pgrepList。 */
  _findProcessesByCmd(pat) {
    try {
      return pidlook.pgrepList(pat).map((m) => ({ pid: m.pid, cmdline: m.cmdline }));
    } catch { return []; }
  }

  /** 清理非本守卫托管的残留 frpc（cmdline 含本项目配置文件的孤儿进程）。 */
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

  /** HTTP(S) 下载（供 install 与测试桩覆盖）。 */
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
