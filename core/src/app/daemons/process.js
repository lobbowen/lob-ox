'use strict';

const spawnOS = require('../../platform/os/spawn');

// 受管进程生命周期核心（router-daemon / lan-daemon / 常驻进程共用）。
// 不变量：一个逻辑服务=一个受管进程；换代按 TERM 旧代、短暂 latch、spawn 顺序执行，latch 窗口内不得再 spawn；
// 守卫重启按身份文件 owner 连续接管，身份丢失/异主不接管；本层只对进程负责，端口分配归端口注册表。

const fs = require('node:fs');
const path = require('node:path');
const pidlook = require('../../platform/os/pidlookup');
const { writeAtomic } = require('../../platform/util/fs');
const { waitProcessExit, waitPortFree } = require('./process-wait');
const { deriveCmdMarks } = require('./process-marks');

class DaemonLifecycle {
  /** @param o 配置：name（'router' | 'lan'）、script/args（spawn 命令）、ctlPort（就绪/换代仲裁端口）、
   *  cmdMark（cmdline 识别子串，防误接管异主）、identityFile（JSON {guardPid, daemonPid, startedAt}）、
   *  spawnEnv(extra) / logger / events、readyTimeoutMs / stopGraceMs / portReleaseTimeoutMs / spawnWindowMs。 */
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
    // 退出意图谓词钩子（守卫注入 host._exitIntended，单源）。ensureRunning 是全部 daemon spawn 的必经
    //   入口，仅有内存 _stopping 不够——「退出管家」后守卫被外部拉起的那拍，会话/持久标记同样必须否决 spawn。
    this._exitIntended = typeof o.exitIntended === 'function' ? o.exitIntended : () => false;
    this._spawnWindowUntil = 0; // spawn latch
    this._stopping = false;
  }

  /* 身份文件（owner 连续的关键） */
  _readIdentity() {
    try { return JSON.parse(fs.readFileSync(this.identityFile, 'utf8')); } catch { return null; }
  }
  _writeIdentity(daemonPid) {
    try {
      const dir = path.dirname(this.identityFile);
      try { fs.mkdirSync(dir, { recursive: true }); } catch {}
      writeAtomic(this.identityFile, JSON.stringify({ guardPid: process.pid, daemonPid, startedAt: Date.now() }), { mode: 0o600 });
    } catch (e) {
      // 身份文件写失败必须留痕：它决定下次守卫重启能否按 owner 连续接管该 daemon；
      //   静默失败会让接管判定退回 cmdline 形态，异主/双监督风险变成不可见的。
      if (this.logger && this.logger.warn) this.logger.warn(this.name + ' identity write failed: ' + ((e && e.message) || e));
      try { if (this.events && this.events.append) this.events.append('daemon_identity_write_error', { name: this.name, pid: daemonPid, error: (e && e.message) || String(e) }); } catch {}
    }
  }
  _clearIdentity() { try { fs.unlinkSync(this.identityFile); } catch {} }

  /** 判活（platform/pidlookup.probeAlive 单源）：unknown 不 fail-open——必须有第二条证据
   *  （ctl 端口属主正是该 pid 且 cmdline 匹配本服务）才认活，否则按死走 reclaim/spawn。
   *  fail-open 会让已死 daemon 被判活，此后既不接管也不拉起，永不自愈。 */
  _pidAlive(pid) {
    if (!pid) return false;
    const st = pidlook.probeAlive(pid);
    if (st === 'alive') return true;
    if (st === 'dead') return false;
    return this._ctlOwnerPid() === pid;
  }

  /** ctl 端口的监听者是否就是本服务进程（cmdline 匹配）。 */
  _ctlOwnerPid() {
    try {
      const pid = pidlook.findListeningPid(this.ctlPort);
      if (!pid) return null;
      // 两侧都要归一化：_cmdMarks 已被构造器 norm() 成 "/"，而 readCmdline 返回原生分隔符；
      // Windows 的 cmdline 是反斜杠，直接 indexOf 永远 -1，会认不出自己的 daemon。
      const cmd = pidlook.normCmdline(pidlook.readCmdline(pid) || '');
      // 按全部标记匹配（语义 cmdMark + 从 script 派生的路径形态）。
      return this._cmdMarks.some((mk) => mk && cmd.indexOf(mk) >= 0) ? pid : null;
    } catch { return null; }
  }

  /** 当前「期望进程」= 身份文件里的 daemonPid（若还活着）。 */
  expectedPid() { const id = this._readIdentity(); return id && id.daemonPid ? id.daemonPid : null; }

  /** 回收非当前受管代际的旧代进程：YAMA 下 /proc fd 对非祖先不可读、socket 到 pid 无法映射，
   *  故用 pgrep -af 读 cmdline（跨平台/YAMA 免疫）。命中本 daemon 特征且 pid 非当前身份 pid/自己/
   *  ctl 属主者一律视为旧代残留，TERM 回收。@returns 回收数 */
  reclaimOrphans() {
    // cfg = args 中 -c/--config 的值（生产 daemon 为 configPath，用于精确匹配防误杀其它实例/用户）；
    // 无 -c（如测试夹具/简化调用）时 cfg 为空，仅按 cmdMark 匹配（仍排除自己/受管代/ctl 属主）。
    const args = this.args || [];
    let cfg = '';
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '-c' || args[i] === '--config') { cfg = String(args[i + 1] || ''); break; }
    }
    // pgrepList 每次只接受一个 pattern，故对每个标记各查一遍并按 pid 去重
    //   （只用语义标记会匹配 0 个，孤儿回收会空跑）。
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
        if (pid === mine) continue;             // 当前受管代际
        if (pid === ctlOwner) continue;         // ctl 属主（就是当前在管进程）
        if (cfg && cmd.indexOf(cfg) < 0) continue; // 必须同配置（防误杀其它用户/实例的同名 daemon）
        try { process.kill(pid, 'SIGTERM'); killed++; this.logger.warn && this.logger.warn('[' + this.name + '] 回收旧代孤儿 pid=' + pid + ' ' + cmd.slice(0, 90)); } catch {}
      }
    } catch (e) { /* pgrep 无匹配/不可用：忽略 */ }
    return killed;
  }

  /** 换代/启动仲裁总入口：期望 pid 活 -> {mode:'adopted', pid}；无进程 -> spawn（latch）-> {mode:'started', pid}；
   *  期望 pid 死或失联 -> reclaiming（停残留，短 latch 后下一轮 spawn）；spawn latch 窗口内 -> {mode:'barrier'}。 */
  ensureRunning() {
    if (this._stopping) return { mode: 'stopping' };
    try { this.reclaimOrphans(); } catch {}
    const exp = this.expectedPid();
    if (exp && this._pidAlive(exp)) {
      // 期望进程在：等就绪（首次可能 ctl 未起）；直接认为在管（监督层再按 ctl 判 ready）
      return { mode: 'adopted', pid: exp };
    }
    if (Date.now() < this._spawnWindowUntil) return { mode: 'barrier' };
    // 换代前：ctl 若仍被「本 cmdMark 的残留」占着则 TERM，等死 + 等端口释放；绝不起新
    const stale = this._ctlOwnerPid();
    if (stale) {
      this._stopPid(stale);
      this._spawnWindowUntil = Date.now() + 3000; // 短暂 latch：等旧代退出，下一轮仲裁走 spawn
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
    // E-3 门禁：spawn 是唯一的「复活」动作，任何入口（ensure/换代/监督）都必须过退出意图闸。
    if (this._stopping || this._exitIntended()) return { mode: 'stopping' };
    // 经统一封装：daemon 用 detached:true + stdio 'ignore'，走 detached()（固定 detached+windowsHide；
    // 不加 windowsHide 时 detached 会在 Windows 上新建控制台窗口）。
    const child = spawnOS.detached(process.execPath, [this.script, ...this.args], {
      stdio: 'ignore', env: { ...process.env, ...(this.spawnEnv() || {}) },
    });
    // 必须接住异步 'error'，且 child.pid 未确认时不得写身份：spawn 对 ENOENT/EPERM 不抛同步错、只发
    //   异步 'error'（否则逃逸为守卫 uncaughtException）；若写入 daemonPid: undefined，expectedPid() 与
    //   监督会永久误判「期望进程存在」，每轮都 spawn。
    child.on('error', (e) => {
      if (this.logger && this.logger.warn) this.logger.warn('[' + this.name + '] daemon spawn error: ' + ((e && e.message) || e));
      try { if (this.events && this.events.append) this.events.append('daemon_spawn_error', { name: this.name, error: (e && e.message) || String(e), script: this.script }); } catch {}
    });
    child.unref();
    this._spawnWindowUntil = Date.now() + this.spawnWindowMs;
    if (!child.pid) {
      // 未启动：不写身份（写了会让后续监督永久误判「期望进程存在」）。
      this.logger.warn && this.logger.warn('[' + this.name + '] daemon 未启动（' + this.script + ' 不存在或不可执行）');
      return { mode: 'failed', error: 'daemon 未启动（脚本不可执行或 Node 不可用）', script: this.script };
    }
    this._writeIdentity(child.pid);
    if (this.logger && this.logger.info) this.logger.info('[' + this.name + '] 已拉起独立 daemon pid=' + child.pid + '（spawn 窗口至 ' + new Date(this._spawnWindowUntil).toISOString() + '）');
    return { mode: 'started', pid: child.pid };
  }

  /** 无副作用分类（供监督/审计共用，绝不 spawn/stop）：running 期望代际存活 / external ctl 被异 cmdMark 进程
   *  占用（绝不接管）/ reclaiming 期望已死且同 cmdMark 残留占 ctl / barrier latch 窗口内 / absent 可 spawn /
   *  stopping 停止中。监督与停止路径据此识别「异主 daemon」——ensureRunning 只按 cmdline 判 active，分不清两者。 */
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

  /** 周期监督：classify() 分类（无副作用）后再施加副作用（reclaim/spawn）；期望进程失联则先验证
   *  死透再 replace（死透由 ensureRunning 的 stale/死 pid 分支处理）。 */
  async superviseOnce() {
    if (!this.expectedPid()) { try { this.reclaimOrphans(); } catch {} }
    const c = this.classify();
    if (c.mode === 'running' || c.mode === 'external' || c.mode === 'barrier' || c.mode === 'stopping') return c;
    if (c.mode === 'reclaiming') {
      // 期望 pid 已死但 ctl 仍被同 cmdMark 残留占着：停残留并等释放（换代）
      this._stopPid(c.stale);
      this._spawnWindowUntil = Date.now() + 3000;
      return c;
    }
    // absent：无进程无残留则 spawn
    return this._spawn();
  }

  /** 停服：TERM、等死、等 ctl 端口释放、清身份（绑定注册表由被管进程侧语义保留）。 */
  async stop() {
    this._stopping = true;
    const exp = this.expectedPid();
    let stopped = null;
    if (exp && this._pidAlive(exp)) { this._stopPid(exp); stopped = exp; }
    else {
      const owner = this._ctlOwnerPid();
      if (owner) { this._stopPid(owner); stopped = owner; }
    }
    // 停止失败必须如实回报，且不得清身份：超时是唯一的失败信号。若只 warn 后无条件 _clearIdentity()
    //   并返回 ok:true，对不响应 SIGTERM 的 daemon，守卫会宣告「已停」并抹掉身份，此后无人再知道该
    //   pid，孤儿继续占 ctl/relay 端口。故超时返回 ok:false 且保留身份，让下一轮监督重试。
    //   端口未释放不改变 ok，只经 portFree 标志如实上报。
    let dead = true;
    if (stopped) {
      dead = await waitProcessExit(stopped, this.stopGraceMs + 1500);
      if (!dead) this.logger.warn && this.logger.warn('[' + this.name + '] 停止超时 pid=' + stopped);
    }
    const portFree = await waitPortFree(this.ctlPort, this.portReleaseTimeoutMs);
    if (!portFree) this.logger.warn && this.logger.warn('[' + this.name + '] 停止后端口 ' + this.ctlPort + ' 未释放');
    // 复位停止闸门：实例被 stop 后仍可再次 ensureRunning（若置 true 后不复位，复用的实例会永远返回 stopping）。
    this._stopping = false;
    this._spawnWindowUntil = 0; // 清 latch，允许下轮直接裁决（不留陈旧 spawn 窗口）
    if (!dead) {
      // 进程未死：不清身份（否则孤儿再无人可寻），如实上报。
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
