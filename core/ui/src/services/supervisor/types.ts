/**
 * supervisor 宿主领域类型（对齐 dsh-supervisor HTTP API 实契约）。
 * 只放纯数据类型，不含任何实现。
 */

// -- /status ----------------------------------------------
export type DshPhase =
  | "RUNNING" | "STOPPED" | "STARTING" | "RESTARTING"
  | "BACKOFF" | "OBSERVED" | string;

export type NativeInstallState =
  | "uninstalled" | "installing" | "installed" | "uninstalling" | string;

export interface NativeDshStatus {
  installed: boolean;
  version?: string | null;
  binPath?: string | null;
  executable?: boolean;
  state?: NativeInstallState;
  installLog?: string[];
  lastInstall?: { version?: string; error?: string } | null;
  lastUninstall?: unknown;
  task?: unknown;
}

export interface DshVersionInfo {
  installed?: string;
  latest?: string;
  updateAvailable?: boolean;
  lastCheckAt?: string | null;
  checking?: boolean;
  error?: string | null;
}

export type UpgradeStateName = "idle" | "running" | "done" | "failed" | "rolling_back" | string;
export interface UpgradeState {
  state: UpgradeStateName;
  step?: string | null;
  targetVersion?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  lastError?: string | null;
  rolledBack?: boolean;
  logTail?: string[];
}

// 与 phase 正交：phase 是 main 状态机相位，sessionState 是整个服务链的运行相位。
export type SessionState = "starting" | "running" | "stopping" | "stopped" | "failed" | string;

export interface SupervisorStatus {
  desired?: "running" | "stopped";
  phase?: DshPhase;
  sessionState?: SessionState;
  guardVersion?: string;
  /** 安装标识（UUID v4）：灰度名单的匹配依据。 */
  installId?: string | null;
  dshPid?: number | null;
  dshPort?: number | null;
  adopted?: boolean;
  guardPid?: number;
  lastProbeAt?: string | null;
  lastProbeOk?: boolean;
  restartCount?: number;
  backoffLevel?: number;
  backoffUntil?: string | null;
  lastFailure?: string | null;
  upgradeHold?: boolean;
  /** 用户「退出管家」持久标记：退出后守卫重启不得凭看护把壳拉回。 */
  shellHalted?: boolean;
  commandMissing?: boolean;
  dshTokenCaptured?: boolean;
  native?: NativeDshStatus;
  version?: DshVersionInfo;
  upgrade?: UpgradeState;
  tasks?: unknown[];
  updatedAt?: string;
}

// -- /events ----------------------------------------------
export interface SupervisorEvent {
  seq?: number;
  type: string;
  ts: string;
  data?: {
    reason?: string;
    message?: string;
    pid?: number;
    desired?: string;
    model?: string;
    tokens?: number;
    key?: string;
    provider?: string;
    port?: number;
    version?: string;
    [k: string]: unknown;
  } | null;
}
export interface EventsPage { seq: number; events: SupervisorEvent[]; }

// -- /ports（端口注册表：对接后端的全部已注册端口）--
export interface PortRecord {
  port: number;
  role: string;
  owner: string | null;
  createdAt: number;
  /** 端口当前是否真实在监听（true=激活，false=停用）。 */
  active?: boolean;
}
export interface PortsResponse { records?: PortRecord[]; }


// -- /instances ------------------------------------------
export type InstanceDomain = "native" | "sandbox";
export interface InstanceSandbox { privateTmp?: boolean; protectHome?: boolean; }
export interface InstanceState {
  pid?: number | null;
  running: boolean;
  isDsh?: boolean;
  phase?: string;
  lifecyclePhase?: "STARTING" | "RUNNING" | "INSTALLING" | "BACKOFF" | "FAILED" | "STOPPED" | string;
  lastError?: string | null;
  /** 稳定性统计（后端投影，与原生主卡同源）：重启次数 / 最近故障原因 */
  restartCount?: number;
  lastFailure?: string | null;
  /** 当次启动生效的动态配额（守卫按机器预算与活跃实例数推导；未启动过为空） */
  allocation?: { memoryMax: string; cpuQuota: string } | null;
  /** 实测占用（监督拍采样回填；未采到/已停止为 null，与 allocation 成对展示） */
  usage?: { memMb: number | null; cpuPct: number | null; at: number } | null;
  installing?: boolean;
  installOk?: boolean;
  installError?: string | null;
  installLog?: string[];
}
export interface InstanceUpdateJob {
  state: string;
  step?: string | null;
  errors?: number;
  error?: string | null;
}
export interface SupervisorInstance {
  id: string;
  name: string;
  port: number;
  domain: InstanceDomain;
  kind?: string;
  guardian: boolean;
  /** 远程控制三态意图（off|lan|wan）；就绪态/访问 URL 的单一来源是 LanItem.remote 视图。 */
  remoteMode?: RemoteMode;
  unitName?: string;
  sandbox?: InstanceSandbox;
  version?: string | null;
  latest?: string | null;
  updateAvailable?: boolean;
  updateJob?: InstanceUpdateJob | null;
  state?: InstanceState;
  authUrl?: string;
  /** 后端实例装饰（src/api/domains/instances.js）：loopback 时为 true；属后端返回契约。 */
  tokenPresent?: boolean;
  /** 远程访问令牌是否已设（布尔，任何来源都下发）；远程控制页的钥匙状态以此为准。 */
  tokenSet?: boolean;
  /** 远程访问令牌明文：仅内核所在机器（回环来源）下发，与 authUrl 的 ?token= 同一判据。
   *  远程访客读到的是 undefined，令牌的查看/修改因此只在本机面板闭环。 */
  remoteToken?: string;
}
/** /instances 响应：instances[] 仅沙箱（管理对象）；native 为原生主干 main 的只读条目。
 *  main 的生命周期/升级不属沙箱 API：启停走 /lifecycle/dsh/*，安装/升级走 /native/*。 */
export interface InstancesResponse {
  instances: SupervisorInstance[];
  native?: SupervisorInstance | null;
}

// -- /lan-access + /remote/* ------------------------------
/** 远程控制三态（唯一意图字段；写入口 /remote/set-mode）。 */
export type RemoteMode = "off" | "lan" | "wan";
/** 远程访问单一视图：后端 relay/core.projectRemoteView 是唯一事实源，前端零判定直消费。
 *  ready = 可扫码即用（relay 监听 + cookie 已注入；wan 另要求已设令牌 + frps 地址 + frpc 隧道存活）；
 *  reasons = 未就绪原因（按优先级）。accessUrl 与 ready 正交：端口/地址已定即给出，未就绪也可复制访问。 */
export interface RemoteView {
  mode: RemoteMode;
  ready: boolean;
  accessUrl: string | null;
  reasons: string[];
}
export interface LanItem {
  id: string;
  name?: string;
  dshPort: number;
  wanPort?: number | null;
  running: boolean;
  /** 访问令牌是否已设（布尔，后端不下发明文）——wan 模式的就绪前置。 */
  tokenSet?: boolean;
  /** 远程单一视图（mode/ready/accessUrl/reasons）；off 实例后端不下发条目时为 null。 */
  remote?: RemoteView | null;
  /** 注入状态（后端白名单下发，不含任何令牌明文）：tokenSet/cookieReady + 最近成败。 */
  inject?: {
    tokenSet?: boolean;
    cookieReady?: boolean;
    lastOkAt?: number | null;
    lastError?: string | null;
    lastErrorAt?: number | null;
  } | null;
}
export interface LanAccessResponse { items: LanItem[]; addresses: string[]; }
// /remote/frp 状态面只下发 authTokenSet 布尔，不回显令牌明文；提交为 patch 语义（字段缺省=服务端保留现值），
// 故 authToken 可选（仅提交新值时带）。无总闸字段：frpc 生命周期单一条件 = 存在 wan 模式受管实例（syncFromInstances）。
export interface FrpSettings { serverAddr: string; serverPort: number; authToken?: string; authTokenSet?: boolean; user?: string; }
export interface FrpStatus {
  installed: boolean;
  running: boolean;
  pid?: number | null;
  settings: FrpSettings;
  logTail?: string[];
  /** wan 暴露清单；port = 隧道口（与本机 relay wanPort 恒同号）。 */
  instancesExposed?: Array<{ id?: string; name?: string; port?: number | null }>;
}

// -- router ----------------------------------------------
export type ProviderKind = "direct" | "proxy";
export type AccountStatus =
  | "registering" | "frozen" | "banned" | "discarded" | "ready" | "normal" | string;
export interface QuotaWindow {
  status?: string;
  percent?: number;
  resetsAt?: string | number;
}
export interface AccountQuota {
  rolling?: QuotaWindow;
  weekly?: QuotaWindow;
  monthly?: QuotaWindow;
  monthlyRemaining?: number;
  /** 月额度随订阅续期重置时刻。 */
  monthlyResetAt?: number | null;
  /** Command /alpha/billing/credits 原体透传：belowThreshold/creditThreshold 为上游低余额提醒 */
  credits?: {
    monthlyCredits?: number | null;
    purchasedCredits?: number | null;
    freeCredits?: number | null;
    belowThreshold?: boolean;
    creditThreshold?: number | null;
  } | null;
}
export interface ProviderAccount {
  keyId: string;
  maskedKey: string;
  status: AccountStatus;
  instanceStatus?: string;
  quota?: AccountQuota;
  quotaStatus?: string;
  usable?: boolean;
  /** 当前在用（= 显式锁定 或 自动在用 activeAccount）；账号行高亮依据 */
  selected?: boolean;
  /** 用户显式锁定（持久化 selectedAccountKeyId 指向本账号；区别于自动在用的 selected） */
  locked?: boolean;
  healthy?: boolean;
  requests?: number;
  totalTokens?: number;
  version?: string | null;
  updateAvailable?: boolean;
  registeredAt?: number;
  detectError?: string | null;
  nextResetAt?: number | null;
  /** 受限原因与恢复方式（window=到点恢复 / credits=充值后轮询恢复 / banned=人工复核） */
  limit?: {
    kind?: "window" | "credits" | "banned";
    since?: number;
    reason?: string | null;
    recovery?: { type?: "at" | "poll" | "manual"; at?: number | null; periodMs?: number | null } | null;
  } | null;
}
export interface RouterProvider {
  id: string;
  name: string;
  kind: ProviderKind;
  proxyAppId?: string | null;
  activated?: boolean;
  active?: boolean;
  exhausted?: boolean;
  apiPort?: number;
  apiBase?: string;
  accounts?: ProviderAccount[];
  /** 持久化显式锁定账号（null=未手动锁，路由自动在用） */
  selectedAccountKeyId?: string | null;
  /** 显式锁定标志（区分自动在用） */
  locked?: boolean;
  /** 当前在用/锁定账号 keyId（列表/头部同源锚点） */
  activeKeyId?: string | null;
}
export interface ProviderPreset {
  id: string;
  name: string;
  baseUrl?: string;
  plan?: { per5hUsd?: number; weeklyUsd?: number; monthlyUsd?: number } | null;
  adapter?: unknown;
  pricing?: unknown;
  note?: string;
}
export interface ProxyAppInfo {
  id: string;
  name: string;
  registry?: unknown;
  installed?: string;
  latest?: string;
  updateAvailable?: boolean;
}
export interface RouterStatus {
  running: boolean;
  autostart?: boolean;
  activatedProviders?: number;
  usage: {
    requests: number;
    errors: number;
    totalTokens: number;
    promptTokens?: number;
    completionTokens?: number;
    costUsd?: number | null;
  };
  providers?: RouterProvider[];
}
export interface ProvidersResponse {
  presets?: ProviderPreset[];
  providers?: RouterProvider[];
  proxyApps?: ProxyAppInfo[];
}
// -- /tasks ----------------------------------------------
export type TaskKind = "native" | "instance" | "plugin" | "proxy-app";
export type TaskAction = "install" | "upgrade" | "uninstall" | "update";
export type TaskState = "pending" | "running" | "succeeded" | "failed" | "skipped" | "canceled" | string;
export interface TaskStep { name: string; state: string; ts?: number; }
export interface TaskRecord {
  id: string;
  kind: TaskKind;
  action: TaskAction;
  target: { id?: string; name: string };
  from?: string | null;
  to?: string | null;
  state: TaskState;
  error?: string | null;
  steps?: TaskStep[];
  logTail?: string[];
  startedAt?: number;
  finishedAt?: number | null;
  createdBy?: string;
  meta?: Record<string, unknown>;
}
export interface TasksResponse { tasks: TaskRecord[]; current?: unknown; }

// -- plugins ---------------------------------------------
export type PluginSource = "npm" | "github" | "community" | "official";
export interface MarketPlugin {
  name: string;
  description?: string;
  source: PluginSource;
  category: string;
  version?: string;
  stars?: number;
  author?: string;
}
export interface MarketResponse {
  plugins: MarketPlugin[];
  indexedAt?: number;
  sources?: { npm?: number; github?: number; community?: number; official?: number };
  /** 索引正在后台构建：读端点立即回快照而不等构建，面板据此轮询（等同步响应会被 15s 计时误判成失败）。 */
  building?: boolean;
  /** 上一次构建失败的原因。有值且 plugins 为空 = 真取不到，不是「没有插件」。 */
  error?: string | null;
}
export interface PluginTargetInfo { id: string; name: string; kind: string; }
export interface InstalledPlugin {
  name: string;
  version?: string;
  bundle?: boolean;
  source?: string;
  description?: string;
  enabled?: boolean;
  targets?: string[];
  targetNames?: string[];
  /** 插件目录体积（字节，后端统计首目标安装目录） */
  size?: number;
}
export interface InstalledPluginsResponse {
  ok?: boolean;
  inventoryReachable?: boolean;
  profile?: string;
  targets?: PluginTargetInfo[];
  rows?: unknown[];
  thirdParty?: InstalledPlugin[];
  builtinBundles?: Array<{ name: string; readonly?: boolean }>;
  installationOwned?: string[];
}
export interface PluginUpdatesResponse {
  plugins?: Array<{ name: string; updateAvailable?: boolean; error?: string | null; targets?: Array<{ name: string; updateAvailable?: boolean; latest?: string }> }>;
  checkedAt?: number;
  /** registry 往返在后台跑（同 /plugins/market 口径），面板轮询到 false 才宣布结论。 */
  refreshing?: boolean;
  /** 逐插件「取不到版本」原因的汇总；有它就不能报「全部已是最新」。 */
  error?: string | null;
}
// 插件任务进度（后端 /plugins/install-status?job= 派生自 TaskRegistry；前端轮询到 done/failed）
export type JobState = "running" | "done" | "failed";
export interface PluginJobStatus {
  id?: string;
  kind?: string;
  name?: string;
  target?: string;
  state?: JobState;
  startedAt?: number | null;
  finishedAt?: number | null;
  error?: string | null;
  targets?: Array<{ name?: string; ok?: boolean; error?: string | null }>;
  error_?: never;
}
// 反代更新任务进度（/router/proxy/update/status；steps 逐实例，支持多实例依次更新可视化）
export interface ProxyUpdateStatus {
  state?: JobState;
  restarted?: number;
  errors?: number;
  startedAt?: number | null;
  finishedAt?: number | null;
  steps?: Array<{ name: string; state: string }>;
  taskId?: string;
  error?: string;
}
// -- settings / env / guard / registry / self-update -----
export interface AutostartStatus { on: boolean; unit?: string; gui?: boolean; }
export interface LanPanelStatus { enabled: boolean; host?: string; port?: number; urls?: string[]; }
export interface AccessKeyStatus { configured: boolean; host?: string; }
export type CloseAction = "hide" | "exit";
export interface CloseActionStatus { closeAction: CloseAction; }
export interface AccessKeyResult extends AccessKeyStatus { ok: boolean; error?: string; }
export interface RegistryInfo {
  ok?: boolean;
  mode: "auto" | "manual";
  origin?: string;
  manual?: boolean;
  manualOrigin?: string;
  candidates?: Array<{ origin: string }>;
  /** 镜像目录（基址字符串，来自壳投放的契约） */
  presets?: string[];
  latencyMs?: number;
  checkedAt?: number;
  probes?: Array<{ origin: string; ok: boolean; latencyMs: number | null; error?: string | null }>;
  /** 消费顺延序列（primary 第一，其余按延迟） */
  ordered?: string[];
  /** 本次选择依据：shell-probe（采用壳契约里的同轮测速证据）| probe（内核自测速）| manual | unreachable */
  source?: string;
  /** 逐源形态判定与探测结论（非法基址也要指名，否则用户只看到「取不到版本」） */
  registries?: Array<{
    base: string; usable: boolean; violation: string | null;
    reachable: boolean | null; latencyMs: number | null; error: string | null;
  }>;
  rejectedOrigins?: string[];
  /** 契约 schema（不可用时 null）：v2 与 v3 在排障时是两回事（选择字段是否还住在契约里） */
  contractSchema?: number | null;
  error?: string;
}
export interface SelfUpdateStatus {
  ok: boolean;
  installed?: string;
  latest?: string;
  updateAvailable?: boolean;
  error?: string | null;
  restartRequired?: boolean;
}
export interface GuardVersion { version?: string; commit?: string; latest?: string; updateAvailable?: boolean; upstream?: string; }
// -- 桌面壳（Tauri 壳）版本与更新 ------------------------------
// 壳版本来自壳启动时写入的 identity.json（经 /shell/status）。
export interface ShellIdentity {
  version?: string;
  platform?: string;
  arch?: string;
  /** 运行时安装形态：deb / rpm / appimage / msi / nsis / app */
  installKind?: string;
  /** 是否具备自更新能力（形态受支持且有提权通道） */
  selfUpdateCapable?: boolean;
  attempt?: number;
  phase?: string;
  pinned?: string[];
}
export interface ShellStatus {
  ok?: boolean;
  identity?: ShellIdentity | null;
  journal?: { to?: string | null; confirmed?: boolean; rolledBack?: boolean; pinnedVersions?: string[] } | null;
  state?: string;
  reason?: string | null;
  pinned?: string[];
  dir?: string;
}
export interface ShellUpdateCheck {
  ok: boolean;
  installed?: string | null;
  latest?: string | null;
  updateAvailable?: boolean;
  error?: string | null;
}
// 平台能力矩阵：三平台静态档位 x 实际工具探测，UI 据此灰化/提示不支持项。
export interface PlatformCapabilities {
  platform?: string;
  arch?: string;
  /** 能否运行沙箱实例舱（systemd 硬档 / portable 软档均可跑舱；仅未知平台为 false） */
  sandboxLaunch?: boolean;
  /** 资源限额执行档位：cgroup 内核硬限额 / supervise 采样式软限 / none 无强制 */
  sandboxEnforcement?: "cgroup" | "supervise" | "none";
  /** 接管既有进程（端口/命令行反查） */
  pidAdoption?: boolean;
  /** 进程树终止（POSIX 组信号 / Windows taskkill /T） */
  processTreeKill?: boolean;
  /** 桌面通知（notify-send / osascript / powershell 气泡） */
  desktopNotify?: boolean;
  /** 开机自启（systemd --user + linger / LaunchAgent / schtasks） */
  autostart?: boolean;
  /** 公网暴露（frpc） */
  frpExpose?: boolean;
  /** 宿主服务形态 */
  hostService?: string;
}
/** 沙箱资源预算总览（governor.budgetSnapshot 形状，/env/status.sandboxBudget）。
 *  内存一律 MB、CPU 一律百分比（单核=100），与后端同源，UI 不做单位换算。 */
export interface SandboxBudget {
  headroom: number;
  memFloorMb: number;
  totalMemMb: number;
  budgetMb: number;
  usedMb: number;
  activeCount: number;
  reservationMb: number;
  cpuCount: number;
  cpuBudgetPct: number;
  cpuUsedPct: number;
  /** 预算可容纳的下限实例数（面板「还能开几个」） */
  capacity: number;
}
/** EnvCatalog 条目（platform/service/env-catalog 的 probe/summary 形状）。
 *  state 五态 ok/outdated/missing/configured/unconfigured；required 项必须在前端同现，不得只挑 Node 渲染。 */
export interface EnvCatalogItem {
  label: string;
  required?: boolean;
  state: string;
  detail?: string;
  /** 有门槛条目（Node）才有：实测版本、门槛、是否达标。 */
  version?: string;
  min?: string;
  meets?: boolean;
}
export interface EnvStatus {
  node?: { detected?: string; runtime?: string | null; path?: string | null };
  /** npm 与 node 同构三段：detected = 本机实跑版本，runtime = 壳投放的实跑版本（null = 未回读），path = 契约解析到的可执行。 */
  npm?: { detected?: string; runtime?: string | null; path?: string | null };
  git?: { detected?: string };
  ok?: boolean;
  npmRoot?: string | null;
  installedAt?: string | null;
  source?: string | null;
  catalog?: { ready?: boolean; items?: Record<string, EnvCatalogItem> };
  capabilities?: PlatformCapabilities | null;
  /** 沙箱资源预算总览（governor 推导，未装配/查询失败为 null） */
  sandboxBudget?: SandboxBudget | null;
  /** 桌面壳看护的观测快照：壳反复拉起失败时面板可见。 */
  shellWatchdog?: {
    enabled?: boolean;
    intervalMs?: number;
    graceMs?: number;
    updateGraceMs?: number;
    maxRestarts?: number;
    absentForMs?: number | null;
    restartsInWindow?: number;
    everSawAlive?: boolean;
    lastSkipReason?: string | null;
    expectedAbsence?: boolean;
  } | null;
}
/** Node.js 环境检测（GET /env/node-lts）。
 *  内核 src/app/settings/node-lts.js::nodeLtsStatus() 不做远端查询（避免守卫启动依赖网络），
 *  实返 { ok, current, major, ltsLine, suggested, fetchedAt, cached }，本类型与之对齐。 */
export interface NodeLtsStatus {
  ok: boolean;
  /** 当前系统 Node 版本（如 26.7.0） */
  current?: string | null;
  /** 当前主版本号 */
  major?: number | null;
  /** 当前主版本是否为偶数（本地保守判定「通常为 LTS 线」，非远端断言） */
  ltsLine?: boolean | null;
  /** 后端生成的展示建议（含是否 LTS 线的说明） */
  suggested?: string | null;
  /** 本次探测时刻（ms） */
  fetchedAt?: number | null;
  /** 是否命中 6h 磁盘缓存 */
  cached?: boolean;
  error?: string | null;
}

export interface GenericOk { ok?: boolean; error?: string | null; [k: string]: unknown; }

/** 外部打开（把 http(s) 地址交给系统默认浏览器）的结果契约，与内核 platform/os/browser.js 的
 *  outcome 同字段。三档语义不得在界面上合并：
 *    confirmed  —— 内核拿到了成功证据（本次启动确定拥有自己的窗口，且它以 0 退出）
 *    handedOff  —— 只是把地址交了出去，窗口是否出现无从证明（ownsWindow 为 false 的形态恒到此档）
 *    ok=false   —— 明确失败，error 为内核给出的一句话，url 仍必须呈现给用户
 *  url 恒在场：任何一档都要能让用户复制/手动打开，不得只报成败。 */
export interface OpenExternalResult {
  ok?: boolean;
  confirmed?: boolean;
  handedOff?: boolean;
  reason?: string | null;
  error?: string | null;
  message?: string | null;
  url?: string | null;
  evidence?: {
    bin?: string | null;
    engine?: string | null;
    via?: string | null;
    /** 本次启动是否确定拥有自己的窗口；false 时退出码在两个方向上都不是证据。 */
    ownsWindow?: boolean;
    /** 一键登录用的隔离窗口是否真的成立（引擎无隔离方言时为 false，此时换账号只能靠超时重发）。 */
    isolated?: boolean;
    /** 隔离 profile 目录（内核分配与回收；非隔离形态为 null）。 */
    profile?: string | null;
    /** 是否监视窗口关闭以取消登录（与 isolated 同源，面板据此说明「关掉窗口即取消」是否成立）。 */
    watch?: boolean;
    exitCode?: number | string | null;
    exitSignal?: string | null;
    error?: string | null;
    /** 分发留痕（内核环境表单的摘要）：这次交给谁、依据哪一层、本机探到哪些候选。
     *  真机报「没弹出网页」时这一份就是定档依据，故必须一路走到屏幕上。 */
    diagnostics?: BrowserDiagnostics | null;
    /** 本次动作的出网判定（内核 environment.js#checkEgress）。只有会开冷档案窗口的动作才有；
     *  null=这条动作不涉及隔离窗口或表单尚未探测。降级与否、依据码与人和话理由都在这一份里。 */
    egress?: EgressVerdict | null;
  } | null;
}

/** 一次动作的出网结论（三态，内核不得把「判不出」折成 false）。
 *  basis 是结论码（进屏幕也进快照），detail 是同一结论的人话版 —— 两者必须一路走到界面上，
 *  否则「为什么这次没用隔离窗」在用户侧只剩一句猜。 */
export interface EgressVerdict {
  host?: string | null;
  /** true=冷档案窗口能出内容；false=注定空白（已降档）；null=判不出，按原档保持隔离。 */
  viable?: boolean | null;
  basis?: string;
  detail?: string | null;
  /** 系统代理读数：on / off / unknown（unknown 不等于 off）。 */
  proxy?: string;
  at?: number | null;
}

/** 打开动作随结果交出的分发摘要（内核 `platform/os/browser.js#launchDiagnostics` 的产出，
 *  与只读端点 `GET /env/environment` 那份完整表单同源）。面板只渲染它，就不必再查一次端点：
 *  失败时屏幕上那一行必须描述**这次**打开所用的那一份清单，而不是另一次探测的结果。 */
export interface BrowserDiagnostics {
  /** 分发依据（内核 platform/os/environment.js#pickLauncher 的 how 字段）：
   *  user-preference / candidate-rank / only-installed / none-found，或系统默认项的来源名；
   *  界面只认「有没有用户选过、是不是回落的」，不认具体来源名字。 */
  pick?: string | null;
  default?: { id: string; source?: string | null } | null;
  /** 用户偏好的读数：id + 是否仍在候选清单里（false = 需重选）。 */
  preference?: { id?: string | null; matched?: boolean } | null;
  found?: Array<{ name?: string | null; engine?: string | null; via?: string }>;
  probed?: Array<{ source: string; detail?: string | number | null }>;
}

/** 环境表单的一个维度读数（内核 environment.js#form 的 sections 值）。
 *  state 四档必须分开呈现：pending = 这一拍还没探过（启动拍/刷新会补），empty = 探了但没内容，
 *  error = 探失败了。把三者混成「没有」正是此前三个就绪口径各说各话的病。
 *  同名字段（count/how/reason…）随维度而异，故开放索引签名，页面只认自己读过的那几个。
 *  一律用 type 而非 interface：维度数据要能当 Record 用（界面按 id 取键），interface 拿不到隐式索引签名。 */
export type EnvironmentSection<T = Record<string, unknown>> = {
  label?: string;
  at?: number | null;
  source?: string;
  state?: 'ok' | 'empty' | 'error' | 'pending' | string;
  data?: T | null;
  error?: string | null;
  [k: string]: unknown;
};

/** 出网条件维度的数据：代理读数 + 已判过的目标主机通路，全三态原样交出。 */
export type EgressSectionData = {
  at?: number | null;
  proxy?: { state?: string; server?: string | null; pac?: string | null; source?: string; cached?: boolean } | null;
  targets?: Record<string, { ok?: boolean | null; stage?: string; detail?: string | null; at?: number | null }>;
  probed?: Array<{ source?: string; detail?: string | number | null }>;
};

/** 运行时维度：node/npm/git 条目沿用内核 EnvCatalog 的条目视图（label/required/state/detail），
 *  镜像源与全局前缀来自分发层与安装用的同一解析口。 */
export type RuntimeSectionData = {
  node?: Record<string, unknown> | null;
  npm?: Record<string, unknown> | null;
  git?: Record<string, unknown> | null;
  registry?: { origin?: string | null; mode?: string | null; source?: string | null; manualOrigin?: string | null;
    candidates?: Array<{ base?: string; reachable?: boolean | null; latencyMs?: number | null; error?: string | null }> } | null;
  prefix?: string | null;
};

/** DSH 维度：本体安装判定 + 内核更新包配置 + 守卫看护状态。 */
export type DshSectionData = {
  dsh?: Record<string, unknown> | null;
  selfUpdate?: Record<string, unknown> | null;
  managed?: boolean;
  phase?: string | null;
};

/** 启动既成事实维度：守卫这一拍**已经跑过**的东西，逐字抄自启动装配的既有局部量。
 *  这里没有计划、没有预期，也没有「本该发生但没读到」的形状 —— 每一格只有在代码真的走过那一步
 *  之后才有值，所以界面看到 null 就是这一拍确实没发生，不需要再猜是不是探测失败。 */
export type StartupSectionData = {
  bootAt?: number | null;
  /** 启动后多久跑环境表单首拍（既成延迟，不是倒计时）。 */
  envDelayMs?: number | null;
  routerAutostart?: boolean | null;
  /** 选路由装配真读出时才算数；null = 这一拍还没到那步。 */
  routerMode?: string | null;
  updateCheck?: { enabled?: boolean; initialDelayMs?: number | null; intervalMs?: number | null } | null;
  shellWatchdog?: boolean | null;
  lastRefresh?: {
    at?: number | null;
    tookMs?: number | null;
    dims?: Record<string, string>;
    browsers?: number | null;
    pick?: string | null;
    snapshotWritten?: boolean | null;
  } | null;
};

/** 桌面壳所见维度：壳投放的环境报告（内核 platform/contract/shell-report.js 的读回产物）。
 *  available=false 要分得清没报过（never-written）与读不出/版本不符（unreadable-or-schema-mismatch），
 *  后者是要去查文件的故障。与 runtime 维**并排而不互相覆盖**：两份实测不一致就是要看的证据。 */
export type ShellSectionData = {
  /** 读回结论三档：true = 拿到一份可报告的壳观测；false 时看 reason，别把读不出说成没写过。 */
  available?: boolean;
  path?: string;
  reason?: 'ok' | 'never-written' | 'unreadable-or-schema-mismatch' | string;
  writtenBy?: string | null;
  schema?: number | null;
  at?: number | null;
  ageMs?: number | null;
  node?: { path?: string | null; binDir?: string | null; version?: string | null; min?: string | null; ok?: boolean | null } | null;
  npm?: { path?: string | null; args?: string[]; version?: string | null; ok?: boolean | null } | null;
  prefix?: { dir?: string | null; writable?: boolean | null; why?: string | null } | null;
  registry?: { best?: string | null; latencyMs?: number | null; probes?: Array<{ url?: string | null; ok?: boolean | null; latencyMs?: number | null }>; probesTotal?: number } | null;
  records?: Array<{ probe?: string; source?: string; target?: string; ms?: number | null; ok?: boolean | null; note?: string }>;
  droppedRecords?: number;
};

/** 维度台账。已知的五张数据形状点名声明（页面据此渲染具体字段），其余维度（浏览器/会话/能力/偏好/
 *  选路，以及未来注册进来的）走索引签名 —— 表单加维度不需要前端先改类型再显示。 */
export type EnvironmentSections = {
  runtime?: EnvironmentSection<RuntimeSectionData>;
  shell?: EnvironmentSection<ShellSectionData>;
  dsh?: EnvironmentSection<DshSectionData>;
  egress?: EnvironmentSection<EgressSectionData>;
  startup?: EnvironmentSection<StartupSectionData>;
  [id: string]: EnvironmentSection | undefined;
};

/** 环境表单（内核 platform/os/environment.js 的装配产物，`GET /env/environment`）。
 *  面板的「环境检测」据此显示本机实况，并提供浏览器偏好选择器 —— 所有外部打开动作的分发依据都在这份里。 */
export interface EnvironmentForm {
  schema?: number;
  at?: number | null;
  cached?: boolean;
  platform?: string | null;
  identity?: { platform?: string; arch?: string; hostname?: string; user?: string | null; node?: string };
  paths?: { root?: string; supervisor?: string; shell?: string };
  session?: { platform?: string; available?: boolean; reason?: string | null; display?: string | null };
  capabilities?: Record<string, unknown> | null;
  preference?: { id?: string | null; configured?: boolean; matched?: boolean; browser?: { id: string; name: string; engine: string } | null; reason?: string };
  default?: { id: string; source?: string | null } | null;
  browsers?: Array<{ id: string; name?: string; bin?: string; engine?: string; sources?: string[]; isDefault?: boolean }>;
  pick?: { how?: string; id?: string | null; name?: string | null; wanted?: string | null; stale?: boolean };
  /** 维度台账（schema 2）：每维度一条 {label, at, source, state, data}。异步维度（运行时/DSH/出网条件）
   *  只由 refresh() 拍，未拍即 state='pending' —— 界面必须照实标未探，不得拿空当结论。 */
  sections?: EnvironmentSections | undefined;
  probed?: Array<{ section?: string; source: string; detail?: string | number | null }>;
  snapshot?: { path?: string; written?: boolean; error?: string | null };
}

/** 上一拍快照的读回口（`GET /env/environment/last`，内核 environment.js#lastSnapshot）。
 *  这是**只读留痕**，与当拍字段完全分离：把它并进当拍就等于拿旧数据冒充刚探出来的结论。
 *  available=false 必须分得清没写过（never-written）与读不出（unreadable-or-schema-mismatch），
 *  后者是要人去查文件的故障，前者只是这台机器还没跑到落盘那一步。 */
export interface EnvironmentSnapshotRead {
  available?: boolean;
  path?: string;
  at?: number | null;
  ageMs?: number | null;
  reason?: 'ok' | 'never-written' | 'unreadable-or-schema-mismatch' | string;
  data?: EnvironmentForm | null;
}

/** 浏览器偏好（`GET|POST /settings/external-browser`）：当前值 + 可选候选 + 这一拍实际会用谁。 */
export interface ExternalBrowserStatus {
  ok?: boolean;
  error?: string | null;
  configured?: boolean;
  value?: string | null;
  /** 偏好所指已不在候选清单（被卸载/路径失效）：分发已回落，界面必须提示重选。 */
  stale?: boolean;
  browser?: { id: string; name?: string; engine?: string; isDefault?: boolean } | null;
  candidates?: Array<{ id: string; name?: string; engine?: string; isDefault?: boolean }>;
  pick?: { how?: string; id?: string | null; name?: string | null; wanted?: string | null; stale?: boolean } | null;
  platform?: string | null;
}

/** 一键登录发起（`POST /router/proxy/login/start`）：外部打开结果 + 回调等待参数 + 隔离结论。
 *  isolated 与 isolatedBasis 必须成对读：「未隔离」既可能是引擎没有隔离方言，也可能是出网条件判定
 *  冷档案注定空白（cold-profile-blocked）—— 两种原因处置完全不同（换浏览器 vs 配系统代理），
 *  合成一句「不支持隔离窗口」就把可修的那一半说丢了。 */
export interface ProxyLoginStart extends OpenExternalResult {
  authUrl?: string;
  state?: string;
  port?: number;
  waitMs?: number;
  opened?: boolean;
  isolated?: boolean;
  /** 依据码：target-reachable / cold-profile-inherits-proxy / cold-profile-blocked /
   *  egress-undetermined / proxy-unreadable / egress-unprobed / isolated / engine-not-isolatable。 */
  isolatedBasis?: string;
  /** 依据码的人话版（来自出网条件维度）；结论与出网无关时为 null。 */
  isolatedDetail?: string | null;
}

// -- /lifecycle----------------------------
export type LifecycleModuleId = "dsh" | "router" | "lan" | "instances" | "plugins";
export interface LifecycleModuleState {
  id: string;
  kind?: string;
  name?: string;
  phase: string;
  desired: string;
  healthy?: boolean;
  guardian?: boolean;
  monitoring?: boolean;
  error?: string | null;
  startedAt?: string | null;
  // 不含 restartCount：它是「用户意图被守护触发了几次」的运行态计数，
  //   在别处暴露（/status 的 restartCount = dsh；instance.state.restartCount = 沙箱）。
  detail?: unknown;
}

