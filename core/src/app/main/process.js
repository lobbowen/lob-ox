'use strict';

// app/main/process.js —— 主进程生命周期（spawn/接管/重启/停止）。
// 导出 { methods }，由 app/assembly/facets.js 装到 host；方法名与 { methods } 形态不可改。
// 事实经 depsOf(host) 惰性缓存取得；applyMainPort(this, ...) 仍显式传宿主：签名要求真实 host 实例。
const spawnOS = require('../../platform/os/spawn');
const pidlook = require('../../platform/os/pidlookup');
const { LineBuffer } = require('../../platform/service/log/log');
const native = require('../../app/native/command');
const { findManagedDshPort, applyMainPort } = require('./port-rederive');

const DEPS = new WeakMap();
// 字段 helper 名：host 上的 _m<Name> 方法，经 deps 转发为 m<Name>。
const HELPERS = ['MissingNotified', 'SetMissingNotified', 'SetSpawnBlockedUntil', 'SetFailStreak', 'SetChild',
  'Child', 'SetAdopted', 'SetAdoptPid', 'AdoptPid', 'SetObservedOnly', 'SetStartDeadline', 'SetBackoffLevel',
  'SetBackoffUntil', 'SetCrashWindowStart', 'SetCrashWindowRestarts', 'SetLastFailure', 'SetLastRestartAt',
  'SetRestartCount', 'RestartCount', 'SetRestartAt'];
function depsOf(host) {
  let d = DEPS.get(host);
  if (!d) {
    d = {
      config: () => host.config, main: () => host.main, events: () => host.events,
      logger: () => host.logger, ui: () => host.ui, state: () => host.state,
      daemons: () => host.daemons, nativeManager: () => host.nativeManager,
      tokenService: () => host.tokenService, dshWriter: () => host.dshWriter,
      pluginManager: () => host.pluginManager, stopping: () => host._stopping,
      writeCrashHalted: (v) => { host._crashHalted = v; },
      spawnCommand: () => host.spawnCommand(),
      beginRestart: (reason, opts) => host._beginRestart(reason, opts),
      // 取得所有权的两条路线（spawn / adopt）都要落归属凭据（实现在 main/signals.js）。
      writeMainOwner: (pid, port) => host._writeMainOwner(pid, port),
    };
    for (const n of HELPERS) d['m' + n] = (...a) => host['_m' + n](...a);
    DEPS.set(host, d);
  }
  return d;
}

module.exports = {
  methods: {
  spawnCommand() {
    const d = depsOf(this);
    return native.nativeCommand(d.config(), d.pluginManager());
  },

  async _startProcess() {
    const d = depsOf(this);
    d.main().actNote('start', 'spawn');
    d.writeCrashHalted(false); // 主动拉起 = 清除崩溃停靠（进入运行流程）
    // 前置条件：原生 DSH 必须已安装才尝试启动。未安装则进入「未安装」状态：
    // 不启动、不重试、不计数崩溃；一次性通知引导安装（与"启动失败"严格区分）。
    const nst = d.nativeManager() ? d.nativeManager().status() : { installed: true };
    if (!nst.installed) {
      d.events().append('dsh_not_installed', { bin: nst.binPath });
      if (!d.mMissingNotified()) {
        d.mSetMissingNotified(true);
        d.ui().notify('未检测到 DeepSeek Harness', '可在 dsh-supervisor 面板一键安装');
      }
      d.mSetSpawnBlockedUntil(Date.now() + 60000); // 冷静期：装好前不再无谓重试
      d.state().setPhase('STOPPED');
      d.mSetFailStreak(0);
      d.state().write();
      return;
    }
    d.events().append('spawn', { command: d.spawnCommand() });
    const [cmd, ...args] = d.spawnCommand();
    let child;
    try {
      // detached：独立进程组，便于按组发信号（DSH 派生子进程一并收到）；进程组语义经 opts.detached:true 保持。
      // 插件 --patch 覆盖层由 spawnCommand()/native.nativeCommand() 统一附加（顶层位置），此处不再拼接。
      // stdio 须保持 ['ignore','pipe','pipe']（下方要读 stdout 里的令牌），故用 piped 而非 detached 封装。
      child = spawnOS.piped(cmd, args, { env: process.env, detached: true });
    } catch (err) {
      d.events().append('spawn_failed', { message: err.message });
      d.logger().error('spawn failed: ' + err.message);
      d.beginRestart('spawn_error', { countCrash: true });
      return;
    }
    d.logger().info('spawn pid=' + child.pid + ' cmd=' + d.spawnCommand().join(' '));
    d.mSetChild(child);
    d.mSetAdopted(false);
    d.mSetAdoptPid(null);
    d.state().setPhase('STARTING');
    d.mSetStartDeadline(Date.now() + d.config().startTimeoutMs);
    // DSH 输出落盘专用日志（行缓冲还原完整行），同时镜像到 stderr 供 journald 收敛。
    // 令牌原文先喂 tokenService；落盘/镜像前对启动 URL 的 ?token= 段脱敏，两处都不留会话令牌明文。
    const sanitizeToken = (l) => String(l).replace(/([?&]token=)[A-Za-z0-9_-]+/g, '$1***');
    const outBuf = new LineBuffer((line) => {
      d.tokenService().feedLine('main', line); // 唯一令牌节点：stdout 源逐行推送（最新行优先）

      const clean = sanitizeToken(line);
      d.dshWriter().write(clean);
      process.stdout.write('[dsh] ' + clean + '\n');
    });
    const errBuf = new LineBuffer((line) => {
      const clean = sanitizeToken('[stderr] ' + line);
      d.dshWriter().write(clean);
      process.stderr.write(clean + '\n');
    });
    child.stdout.on('data', (dd) => { outBuf.push(dd); });
    child.stderr.on('data', (dd) => { errBuf.push(dd); });
    child.on('error', (err) => {
      d.events().append('spawn_error', { message: err.message });
      if (d.mChild() === child && d.state().phase() === 'STARTING') {
        d.mSetChild(null);
        if (err.code === 'ENOENT') {
          // 命令不存在（如 DSH 未安装）：进入冷静期，等面板一键安装，不刷崩溃
          d.events().append('dsh_command_missing', { command: d.config().command[0] });
          d.logger().warn('command missing: ' + d.config().command.join(' ') + ' — 60s 冷静期内不再尝试');
          if (!d.mMissingNotified()) {
            d.mSetMissingNotified(true);
            d.ui().notify('未检测到 DeepSeek Harness', '可在 dsh-supervisor 面板一键安装');
          }
          d.mSetSpawnBlockedUntil(Date.now() + 60000);
          d.state().setPhase('STOPPED');
          d.state().write();
          return;
        }
        d.beginRestart('spawn_error:' + (err.code || 'unknown'), { countCrash: true });
      }
    });
    child.on('exit', (code, signal) => {
      outBuf.flush();
      errBuf.flush();
      if (d.mChild() !== child) return; // 已被 stopProcess 接管
      d.events().append('dsh_exited', { code, signal, phase: d.state().phase() });
      d.mSetChild(null);
      if (d.stopping()) return;
      if (d.state().desired() !== 'running') return;
      if (d.state().phase() === 'RUNNING' || d.state().phase() === 'STARTING') {
        const why = code !== null ? String(code) : 'sig' + signal;
        // 守护语义：RUNNING 崩溃看守护开关——guardian=false 不自动拉起（转 STOPPED 等用户手动），
        // STARTING（用户启动流程）保留重试。
        if (d.state().phase() === 'STARTING' || d.state().guardian()) {
          d.beginRestart('exit:' + why, { countCrash: true });
        } else {
          d.writeCrashHalted(true); // 未守护崩溃：停靠等待显式启动
          d.events().append('guardian_off_exit', { reason: 'child_exit:' + why + ' 未守护，保持停止' });
          d.state().setPhase('STOPPED');
        }
      }
    });
    d.events().append('spawned', { pid: child.pid });
    // 本守卫 spawn 的实例即归本守卫负责，先落凭据再写状态（后续 adopt 判定要读它）。
    d.writeMainOwner(child.pid, d.config().targetPort);
    d.state().write();
  },

  _enterRunning() {
    const d = depsOf(this);
    d.main().actNote('enterRunning', 'healthy');
    const wasRunning = d.state().phase() === 'RUNNING';
    d.state().setPhase('RUNNING');
    d.mSetAdopted(false);
    // 只在真正「进入/恢复到运行中」时重置崩溃窗口/退避并记一次事件；稳态(RUNNING)不再每探测周期重置/刷屏
    if (!wasRunning) {
      d.mSetFailStreak(0);
      d.mSetBackoffLevel(0);
      d.mSetBackoffUntil(null);
      d.mSetCrashWindowStart(null);
      d.mSetCrashWindowRestarts(0);
      const pid = d.mChild() ? d.mChild().pid : null;
      d.events().append('running', { pid });
      d.logger().info('RUNNING pid=' + pid);
      // 进入运行：统一令牌服务按源（spawn=stdout）退避重试捕获最新令牌，
      // 有变化即经 onChange 下发 relay 热换 cookie（覆盖重启后令牌轮换/旧令牌未清空的边界）。
      d.tokenService().scheduleCapture('main');
    }
    d.state().write();
  },

  /** 期望停止下发现无主健康实例：仅观测（拿 pid、如实展示），不强杀不拉起。 */
  _adoptObserved() {
    const d = depsOf(this);
    d.main().actNote('adoptObserved', 'observe');
    d.state().setPhase('OBSERVED');
    d.mSetAdopted(true);
    d.mSetObservedOnly(true);
    d.mSetChild(null);
    d.mSetFailStreak(0);
    d.mSetAdoptPid(pidlook.findListeningPid(d.config().targetPort));
    if (d.mAdoptPid() === null) {
      const found = findManagedDshPort(d.config());
      if (found && found.port && found.port !== d.config().targetPort && applyMainPort(this, found.port, found.pid)) {
        d.config().targetPort = found.port;
        d.mSetAdoptPid(found.pid);
      }
    }
    d.events().append('adopted_observed', { pid: d.mAdoptPid() });
    d.logger().info('observed unmanaged instance pid=' + d.mAdoptPid() + ' (desired=stopped)');
    d.state().write();
  },

  _adopt() {
    const d = depsOf(this);
    d.main().actNote('adopt', 'adopt');
    d.state().setPhase('RUNNING');
    d.mSetAdopted(true);
    d.mSetObservedOnly(false);
    d.mSetChild(null);
    d.mSetFailStreak(0);
    d.mSetBackoffLevel(0);
    d.mSetBackoffUntil(null);
    // 发现接管目标的 pid：使 stop/升级/存活观测对既有实例同样生效
    d.mSetAdoptPid(pidlook.findListeningPid(d.config().targetPort));
    // 原生 DSH 端口可被用户改动（config 默认只是默认），配置端口无监听时从受管 DSH 进程
    // 推导真实端口并更正注册，再以其 pid 接管。
    if (d.mAdoptPid() === null) {
      const found = findManagedDshPort(d.config());
      if (found && found.port && found.port !== d.config().targetPort) {
        if (applyMainPort(this, found.port, found.pid)) {
          d.config().targetPort = found.port;
          d.mSetAdoptPid(found.pid);
        }
      }
    }
    // 校验：接管目标必须是我们管理的进程（启动命令匹配），否则不接管、只告警
    if (d.mAdoptPid() === null || !d.main().isManagedProcess(d.mAdoptPid())) {
      d.mSetAdoptPid(null);
      d.state().setPhase('STOPPED');
      d.daemons().warnOccupied();
      d.state().write();
      return;
    }
    d.events().append('adopted', { pid: d.mAdoptPid() });
    d.logger().info('adopted existing instance pid=' + d.mAdoptPid());
    // 接管即认领——不写凭据的话，另一个守卫只凭 cmdline 相似会把同一个 DSH 再接管一次
    //   （两守卫互相 stop/kill 对方的实例）。
    d.writeMainOwner(d.mAdoptPid(), d.config().targetPort);
    // 接管既有实例：统一令牌服务从已登记源（journald / stdout 行缓冲）取最新令牌并下发
    d.tokenService().scheduleCapture('main');
    d.state().write();
  },

  _beginRestart(reason, opts) {
    const d = depsOf(this);
    const countCrash = !!(opts && opts.countCrash);
    d.mSetLastFailure(reason);
    d.mSetLastRestartAt(new Date().toISOString());
    d.events().append('restart_triggered', { reason });
    d.logger().warn('restart triggered: ' + reason);
    // 实例重启 = DSH 启动令牌轮换：清空已捕获令牌，进入运行后统一令牌服务重新捕获新令牌。
    // 旧令牌随旧进程失效，relay 若继续持有只会换取失败；先清空避免新旧令牌混淆。
    d.tokenService().clear('main');
    if (countCrash) {
      d.mSetRestartCount(d.mRestartCount() + 1);
      d.main().bumpCrashWindow();
    }
    d.state().setPhase('RESTARTING');
    d.mSetFailStreak(0);
    d.mSetRestartAt(Date.now() + d.config().portReleaseWaitMs);
    const child = d.mChild();
    if (child && child.exitCode === null) d.main().killSequence(child);
    // 重启前停掉仍运行中的目标，保证 RESTARTING 到重拉路径畅通：
    //  spawn 托管下被接管的存活实例（如假死触发 http_unhealthy 时进程还活着）杀其 pid；
    //  adopted_exit 场景 adopted 已死，此处 isAlive 为 false 自然跳过，不误杀。
    if (d.mAdoptPid() && pidlook.isAlive(d.mAdoptPid())) {
      try { d.main().killAdopted(d.mAdoptPid()); } catch (e) { d.logger().warn('adopt kill during restart: ' + e.message); }
    }
    d.main().actNote('restart', reason); // 退避记账不改变 restart 动作
    d.state().write();
  },

  stopProcess(reason) {
    const d = depsOf(this);
    d.main().actNote('stop', reason);
    d.events().append('stop', { reason });
    d.logger().info('stop: ' + reason);
    const child = d.mChild();
    const adoptedPid = d.mAdoptPid();
    // 相位裁定：即便 kill 未能确认成功仍置 STOPPED —— controller 的 portUp -> adoptObserved
    //   语义依赖 STOPPED；失败经 stop_failed 事件如实上报，而不是把相位停在中间态。
    d.state().setPhase('STOPPED');
    d.mSetChild(null);
    d.mSetAdopted(false);
    d.mSetAdoptPid(null);
    d.mSetFailStreak(0);
    // kill 派遣可能同步抛错（平台 signalProcess/killTree 实现抛）：不兜住则异常逃出本方法、
    //   跳过 state.write() 且无失败事件 —— 停止半执行而静默。
    try {
      if (child && child.exitCode === null) d.main().killSequence(child);
      else if (adoptedPid) d.main().killAdopted(adoptedPid);
    } catch (e) {
      d.events().append('stop_failed', {
        reason,
        pid: adoptedPid || (child && child.pid) || null,
        error: (e && e.message) || String(e),
      });
      if (d.logger() && d.logger().warn) d.logger().warn('[main] stop 派遣失败: ' + ((e && e.message) || e));
    }
    d.state().write();
  }
  },
};
