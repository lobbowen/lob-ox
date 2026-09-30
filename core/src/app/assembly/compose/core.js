'use strict';

// app/assembly/compose/core.js —— 组装第一步：宿主字段 + 基础设施（日志/令牌/分发/任务）。
// 与 domains/observers 同为具名函数、以 host 显式入参、零 this；装配顺序见 compose.js。

const path = require('node:path');
const platform = require('../../../platform/os/index');
const { normalize } = require('../../../platform/service/config');
const { extension: domainConfigExtension } = require('../../../app/settings/domain-config');
const logcore = require('../../../platform/service/log/logcore');
const { DshTokenService } = require('../../../platform/service/token');
// 环境表单的 runtime/dsh 两维直接复用 EnvCatalog（异步口径）与 native 的现成解析口：
//   见下方 registerSection 的分工说明 —— 表单只记账，采集实现一律不复制。
const { EnvCatalog } = require('../../../platform/service/env-catalog');
const npm = require('../../native/npm');

/** 表单读路径里 `npm root -g` 的上界：默认 15s 会把面板刷新整条吃掉，取不到即如实标未测。 */
const FORM_NPM_ROOT_TIMEOUT_MS = 4000;
const { DistributionManager } = require('../../../platform/distribution/index');
const shellDomain = require('../../../domains/shell/index');
const { TaskRegistry } = require('../../../platform/service/tasks');
const { IntentLedger } = require('../../../app/state/intents');
// DS-G4（反转法）：日志汇聚业务源名单 / 令牌分类的唯一声明处，require 即注入 platform。
// 必须在 LogCore.init（构造 EventHub）与 new DshTokenService 之前。
require('../log-sources');
const { TOKEN_FILE_NAME } = require('../../../app/settings/token-kinds');

function composeCore(host, rawConfig, configPath) {
    host.config = normalize(rawConfig, domainConfigExtension());
    host.configPath = typeof configPath === 'string' ? configPath : null;
    // 环境表单的注入点之二（其一在 platform/os/index.js 绑 capabilities）：用户偏好住在本机配置里，
    //   而 platform 不得 require app（L-1），故装配期把 getter 绑给表单。必须在任何 form()/选路之前，
    //   绑在这里等于「进程活着就一定有偏好可读」，调用点不再层层传参（漏传一处即一条静默降级路）。
    platform.environment.bind({ preference: () => (host.config && host.config.externalBrowser) || null });
    // 环境表单的维度注册（schema 2 的「账本住内核、采集归所有者」）：runtime / dsh 两维的探针
    //   一律复用现成实现 —— EnvCatalog 的异步口径（/env/status 用的就是它）、分发层的镜像源读数、
    //   native 的环境检查与 DSH 判定。本处只做「把探针挂到台账上」，绝不另写一份探测：
    //   三份环境实现各说各话正是本轮要收敛的病（面板上同一台机器出现三个就绪口径）。
    //   探针在刷新期才被调用（启动一拍 + 面板 force），所以引用 host 上的晚装配字段是安全的。
    platform.environment.registerSection('runtime', {
      label: '运行时（Node/npm/git/镜像源/全局前缀）',
      probe: async () => {
        const cat = await new EnvCatalog(host.config).probeAsync();
        const m = host.nativeManager;
        const [reg, prefix] = await Promise.all([
          m && m.dist && typeof m.dist.registryInfo === 'function'
            ? Promise.resolve(m.dist.registryInfo()).catch(() => null) : Promise.resolve(null),
          // 前缀实测就是安装/卸载用的那同一个解析口，只把超时收到表单预算内（默认 15s 会吃掉面板刷新）。
          m ? npm.resolveNpmRoot(m, { timeoutMs: FORM_NPM_ROOT_TIMEOUT_MS }).catch(() => null) : Promise.resolve(null),
        ]);
        return {
          node: cat.node, npm: cat.npm, git: cat.git,
          registry: reg ? {
            origin: reg.origin || null, mode: reg.mode || null, source: reg.source || null,
            manualOrigin: reg.manualOrigin || null,
            candidates: (reg.registries || []).map((r) => ({
              base: r.base, reachable: r.reachable === undefined ? null : r.reachable,
              latencyMs: r.latencyMs === undefined ? null : r.latencyMs, error: r.error || null,
            })),
          } : null,
          // 全局前缀只来自 `npm root -g` 的实测，拿不到就是 null：装/卸落在哪个前缀是排障第一问，
          //   猜一个只会指错地方（壳侧的同名读数在 E4 上报接通后进这一维）。
          prefix: prefix || null,
        };
      },
    });
    platform.environment.registerSection('dsh', {
      label: 'DSH 本体与内核更新',
      probe: async () => {
        const cat = new EnvCatalog(host.config);
        const d = typeof host.dshenvStatus === 'function' ? host.dshenvStatus() : null;
        if (!d) return null;
        return {
          dsh: cat.dshEntry(d.binOk, d.installed, d.bin),
          selfUpdate: cat.selfUpdateEntry(),
          managed: d.managed === true, phase: d.phase || null,
        };
      },
    });
    // 启动既成事实：探针只抄 bootstrap 逐点写下的 host._startupFacts，本层不判定、不补默认值。
    //   没跑到 bootstrap 那一拍即返回 null（台账如实记 empty），而不是编一份「看起来正常」的启动记录。
    platform.environment.registerSection('startup', {
      label: '启动既成事实（守卫这一拍跑过什么）',
      probe: () => {
        const s = host._startupFacts;
        if (!s) return null;
        return {
          bootAt: s.bootAt, envDelayMs: s.envDelayMs,
          routerAutostart: s.routerAutostart, routerMode: s.routerMode,
          updateCheck: s.updateCheck, shellWatchdog: s.shellWatchdog, lastRefresh: s.lastRefresh,
        };
      },
    });
    // 数据目录访问保护：目录级一次即覆盖全部子文件（NTFS 继承 ACE 对既有与新建子项都生效，
    //   逐个热写文件 icacls 会造成写放大）。Unix chmod 0700；Windows icacls 去继承 + 仅当前用户
    //   （POSIX mode 在 Windows 被忽略）。本目录含 apiAccessKey / remoteToken / DSH 会话令牌 / frpc auth.token。
    host._fileProtectStatus = null;
    try {
      const fp = platform.fileProtect;
      const swDir = path.dirname(host.config.stateFile);
      const targets = new Set([swDir]);
      try { targets.add(platform.supervisorDir()); } catch {}
      const results = [];
      for (const d of targets) {
        const pr = fp.ensurePrivateDir(d);
        results.push({ dir: d, ...pr });
      }
      host._fileProtectStatus = results;
      const bad = results.filter((r) => !r.ok);
      if (bad.length) { try { console.warn('[supervisor] 数据目录保护未完全成功: ' + bad.map((b) => b.dir + '(' + b.mode + ':' + (b.reason || '') + ')').join('; ')); } catch {} }
    } catch (e) { try { console.warn('[supervisor] 数据目录保护异常: ' + (e && e.message)); } catch {} }
    host._mSetChild(null);
    host._mSetAdoptPid(null);     // 接管的既有实例 pid（非本守卫 spawn）
    host._mSetPhase('STOPPED');
    host._mSetDesired('running');
    host._mSetRestartCount(0);
    host._mSetCrashWindowStart(null);
    host._mSetCrashWindowRestarts(0);
    host._mSetBackoffLevel(0);
    host._mSetBackoffUntil(null);
    host._mSetRestartAt(null);      // RESTARTING 状态下最早可重启时刻
    host._mSetStartDeadline(null);  // STARTING 状态下启动门截止
    host._mSetFailStreak(0);
    host._mSetLastProbeAt(null);
    host._mSetLastProbeOk(null);
    host._mSetLastFailure(null);
    host._mSetLastRestartAt(null);
    host._mSetAdopted(false);       // 观测到健康但非本守卫 spawn（接管既有实例）
    host._mSetObservedOnly(false);  // 期望停止下的仅观测接管（不强杀不拉起）
    host._mSetSpawnBlockedUntil(null); // 命令缺失（ENOENT）后的冷静期
    host._mSetMissingNotified(false);
    host.manualRestart = false; // POST /lifecycle/dsh/restart 待消费
    host._ticking = false;
    // 显式意图登记簿：动作发生处 register、收敛循环 consume（时间窗布尔会漏消费）。
    host.intents = new IntentLedger();
    host._stopping = false;
    // 会话生命周期（契约 ARCHITECTURE-CONTRACT-phase0）：starting -> running -> stopping -> stopped；
    //   stopping/stopped 期间抑制一切自动拉起（INV-S1）；唯一入口 /session/stop、唯一读取口 /session/status（INV-S2/S4）。
    host._sessionState = 'starting';
    // 未守护崩溃停靠标记（意图单源，瞬态不持久）：guardian=false 的进程崩溃时置 true，
    //   使「desired=running 无条件拉起」不违背守护语义（崩溃不自救）；显式启动/重启/进入运行即清除。
    //   不持久化：守卫重启后按 desired（持久用户意图）恢复运行。
    host._crashHalted = false;
    // 用户「退出管家」的持久标记：守卫被外部/登录重新拉起时内存会话态会遗忘退出意图，
    //   看护就会把刚退出的桌面壳拉回；故退出时落盘、boot 经 loadState 继承。
    //   只在观测到壳已在线（用户重新打开壳）时清除；只抑制壳看护，不动 desired/main 恢复语义。
    host._shellHalted = false;
    host._upgradeHold = false;      // 升级"先停后装"期间暂停自动拉起
    host._upgradeHoldSince = null;  // 兜底自愈：hold 卡死超时自动释放
    host._timer = null;
    host._heartbeatBusy = false; // 唯一心跳慢拍防重叠（main 收敛并入心跳后必防并发）
    host._killTimer = null;
    host._adoptKillTimer = null;
    host._initialCheckTimer = null;
    host._upgradeTimer = null;
    host._shellWatchdogTimer = null;   // 桌面壳看护定时器
    host._lastOccupiedWarn = 0;
    // 瞬态字段统一在此构造初始化：任何实例字段的首次赋值必须发生在这一处。
    // 令牌状态不得驱动进程生命周期（DSH-TOKEN-CONTRACT TK-1/TK-2）：令牌恒存在，
    //   「拿不到」属捕捉链路缺陷而非状态，故不设令牌观察窗字段。
    host._lastMainPortRederive = 0;  // 端口再推导节流
    host._lastOrphanAuditAt = 0;     // 游离对象自检节流
    host._lastOrphanKey = null;
    host._lastOrphanAt = 0;
    host._actWindow = false;         // 收敛窗口（影子记账）
    host._mainTickActs = null;
    host._portActivesCache = null;   // 端口激活探测缓存
    host._lastLanStateJson = null;   // lan-state 内容去重
    host._routerFacade = null;       // router ctl 门面缓存
    host._lc = null;                 // DaemonLifecycle 惰性单例表
    host._dshMainLive = null;        // dsh-main.json live 缓存
    // main(dsh) 影子对比框架（并行不驱动）：影子只纯计算应然下一步并对比实际迁移，零行为变化；
    // 连续零 diff 拍数/累计 diff 拍数仅供日志/事件观测，不进任何决策。
    host._shadowSeq = 0;
    host._shadowConsistentBeats = 0;
    host._shadowDiffBeats = 0;
    host._shadowLast = null;   // 最近一拍影子记录 {seq,phase,shadow,actual,diff}
    host._shadowLoggedSeq = 0; // 已记账的事件拍号（心跳聚合去重）
    // 系统日志：logger/events/dshWriter/EventHub 全部取自每进程唯一的 LogCore（单例 init）。
    const logCore = logcore.init({
      process: 'guard',
      logFile: host.config.supervisorLogFile,
      eventFile: host.config.logFile,
      dshLogFile: host.config.dshLogFile,
      upgradeLogFile: host.config.upgradeLogFile,
      logLevel: host.config.logLevel,
      logMaxBytes: host.config.logMaxBytes,
      eventsMaxBytes: host.config.eventsMaxBytes,
      enableHub: true,
      stateDir: path.dirname(host.config.stateFile),
      aggBase: path.basename(host.config.stateFile || 'state.json', '.json'),
      ctlPorts: { router: Number(host.config.routerCtlPort) || 43107, lan: Number(host.config.lanCtlPort) || 43108 },
      daemonLogs: {
        router: path.join(path.dirname(host.config.stateFile), 'log', 'router-daemon.log'),
        lan: path.join(path.dirname(host.config.stateFile), 'log', 'lan-daemon.log'),
      },
    });
    host.events = logCore.events;
    host.logger = logCore.logger;
    host.dshWriter = logCore.dshWriter;
    // 守卫侧聚合读路径：真实 hub 或 EventReader 降级适配器，永不为 null，
    //   消费方（api/lifecycle.js）不必再写 if(hub)...else... 双语义分支。
    host.eventHub = logCore.reader || logCore.hub;
    // 唯一令牌节点：全系统 DSH 访问令牌的获取/存储/分发都走这里（原生与沙箱共用，
    //   区别只在「源」：spawn=stdout 推送 / systemd=journald 拉取）；令牌变化统一经
    //   onChange 下发消费方（远程控制 relay 热换 cookie），不在各处分散接线。
    host.tokenService = new DshTokenService({ logger: host.logger, events: host.events });
    // main 无 systemd 托管（守卫统一 spawn）：纯 stdout 源 + 0600 原文恢复文件，
    //   守卫重启后从文件尾恢复令牌，免重建 main 的会话中断。
    host.tokenService.attach('main', { file: path.join(path.dirname(host.config.stateFile), TOKEN_FILE_NAME) });
    host.tokenService.onChange((id, token) => {
      if (host.lanDaemonEnabled()) { try { host._syncLanState(); } catch {} return; }
      if (host.lan) { try { host.lan.applyToken(id, token); } catch (e) { host.logger.warn && host.logger.warn('lan applyToken(' + id + '): ' + e.message); } }
    });
    const swDir = path.dirname(host.config.stateFile);
    // 包发布/安装/更新的唯一通道：DSH 自升级与反代子应用共用此实例。镜像配置全局两份文件：契约
    // registry.json 由壳写、内核只读；选择 registry-choice.json 由内核写（只有面板的 setRegistryConfig
    // 走到落盘），反代 daemon 侧只读同一份，两侧才不会一个按手动源、一个按目录选。
    host.dist = new DistributionManager({
      registries: (host.config.registries && host.config.registries.length) ? host.config.registries : ['https://registry.npmjs.org'],
      registryFile: path.join(swDir, 'registry.json'),
      registryChoiceFile: path.join(swDir, 'registry-choice.json'),
      events: host.events,
      logger: host.logger,
      // 灰度事实由本机配置注入（canary:true）；仅 @dsh-sup/* 包消费该开关。
      canary: host.config.canary === true,
    });
    // 桌面壳更新安全网门面（状态/账本/健康/审计）：纯函数式模块，不持有 dist、
    //   不调用任何安装执行器，与内核更新机制完全隔离（D6）。
    host.shellDomain = shellDomain;
    // 安装/升级/卸载/更新的唯一任务注册表（native/instance/plugin/router 共用，含持久化历史）。
    host.tasks = new TaskRegistry({
      stateDir: swDir,
      logger: host.logger,
      events: host.events,
    });
}

module.exports = { composeCore };
