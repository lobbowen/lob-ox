
export type DshPhase =
  | "RUNNING" | "STOPPED" | "STARTING"
  | "OBSERVED" | string;

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

export type SessionState = "starting" | "running" | "stopping" | "stopped" | "failed" | string;

export interface SupervisorStatus {
  desired?: "running" | "stopped";
  phase?: DshPhase;
  sessionState?: SessionState;
  guardVersion?: string;
  installId?: string | null;
  dshPid?: number | null;
  dshPort?: number | null;
  adopted?: boolean;
  guardPid?: number;
  lastProbeAt?: string | null;
  lastProbeOk?: boolean;
  restartCount?: number;
  lastFailure?: string | null;
  upgradeHold?: boolean;
  /** 退出管家持久标记：退出后守卫重启不得凭看护把壳拉回。 */
  shellHalted?: boolean;
  commandMissing?: boolean;
  dshTokenCaptured?: boolean;
  native?: NativeDshStatus;
  version?: DshVersionInfo;
  upgrade?: UpgradeState;
  tasks?: unknown[];
  updatedAt?: string;
}

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

export interface PortRecord {
  port: number;
  role: string;
  owner: string | null;
  createdAt: number;
  active?: boolean;
}
export interface PortsResponse { records?: PortRecord[]; }


export type InstanceDomain = "native" | "sandbox";
export interface InstanceSandbox { privateTmp?: boolean; protectHome?: boolean; }
export interface InstanceState {
  pid?: number | null;
  running: boolean;
  isDsh?: boolean;
  portTaken?: boolean;
  identityUnknown?: boolean;
  phase?: string;
  lifecyclePhase?: "STARTING" | "RUNNING" | "INSTALLING" | "FAILED" | "STOPPED" | string;
  lastError?: string | null;
  restartCount?: number;
  lastFailure?: string | null;
  allocation?: { memoryMax: string; cpuQuota: string } | null;
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
  /** 就绪态/访问 URL 的单一来源是 LanItem.remote 视图。 */
  remoteMode?: RemoteMode;
  unitName?: string;
  sandbox?: InstanceSandbox;
  version?: string | null;
  latest?: string | null;
  updateAvailable?: boolean;
  updateJob?: InstanceUpdateJob | null;
  state?: InstanceState;
  authUrl?: string;
  /** 后端返回契约（src/api/domains/instances.js）：loopback 时为 true。 */
  tokenPresent?: boolean;
  tokenSet?: boolean;
  /** 明文仅回环来源下发（与 authUrl 的 ?token= 同一判据），远程访客读到 undefined。 */
  remoteToken?: string;
}
/** /instances 响应：instances[] 仅沙箱；native 为原生主干 main 的只读条目，启停走 /lifecycle/dsh/*，安装/升级走 /native/*。 */
export interface InstancesResponse {
  instances: SupervisorInstance[];
  native?: SupervisorInstance | null;
}

/** 唯一意图字段；写入口 /remote/set-mode。 */
export type RemoteMode = "off" | "lan" | "wan";
/** 后端 relay/core.projectRemoteView 是唯一事实源，前端零判定直消费；ready = 可扫码即用（wan 另需令牌
 *  + frps 地址 + frpc 隧道存活）；accessUrl 与 ready 正交。 */
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
  tokenSet?: boolean;
  remote?: RemoteView | null;
  /** 后端白名单下发，不含任何令牌明文。 */
  inject?: {
    tokenSet?: boolean;
    cookieReady?: boolean;
    lastOkAt?: number | null;
    lastError?: string | null;
    lastErrorAt?: number | null;
  } | null;
}
export interface LanAccessResponse { items: LanItem[]; addresses: string[]; }
// /remote/frp 只下发 authTokenSet 布尔，不回显令牌明文；提交为 patch 语义（缺省=保留现值），
// 故 authToken 仅提交新值时带。
export interface FrpSettings { serverAddr: string; serverPort: number; authToken?: string; authTokenSet?: boolean; user?: string; }
export interface FrpStatus {
  installed: boolean;
  running: boolean;
  pid?: number | null;
  settings: FrpSettings;
  logTail?: string[];
  /** port = 隧道口，与本机 relay wanPort 恒同号。 */
  instancesExposed?: Array<{ id?: string; name?: string; port?: number | null }>;
}

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
  monthlyResetAt?: number | null;
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
  selected?: boolean;
  locked?: boolean;
  healthy?: boolean;
  requests?: number;
  totalTokens?: number;
  version?: string | null;
  updateAvailable?: boolean;
  registeredAt?: number;
  detectError?: string | null;
  nextResetAt?: number | null;
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
  selectedAccountKeyId?: string | null;
  locked?: boolean;
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
  /** 后台构建时读端点立即回快照：面板须轮询（等同步响应会被 15s 计时误判成失败）。 */
  building?: boolean;
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
  refreshing?: boolean;
  error?: string | null;
}
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
  presets?: string[];
  latencyMs?: number;
  checkedAt?: number;
  probes?: Array<{ origin: string; ok: boolean; latencyMs: number | null; error?: string | null }>;
  ordered?: string[];
  source?: string;
  registries?: Array<{
    base: string; usable: boolean; violation: string | null;
    reachable: boolean | null; latencyMs: number | null; error: string | null;
  }>;
  rejectedOrigins?: string[];
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
export interface ShellIdentity {
  version?: string;
  platform?: string;
  arch?: string;
  installKind?: string;
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
export interface PlatformCapabilities {
  platform?: string;
  arch?: string;
  sandboxLaunch?: boolean;
  sandboxEnforcement?: "cgroup" | "supervise" | "none";
  pidAdoption?: boolean;
  /** POSIX 组信号 / Windows taskkill /T。 */
  processTreeKill?: boolean;
  desktopNotify?: boolean;
  /** systemd --user + linger / LaunchAgent / schtasks。 */
  autostart?: boolean;
  frpExpose?: boolean;
  hostService?: string;
}
/** governor.budgetSnapshot 形状（/env/status.sandboxBudget）：内存一律 MB、CPU 百分比（单核=100），UI 不做换算。 */
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
  capacity: number;
}
/** platform/service/env-catalog 的 probe/summary 形状；required 项必须在前端同现，不得只挑 Node 渲染。 */
export interface EnvCatalogItem {
  label: string;
  required?: boolean;
  state: string;
  detail?: string;
  version?: string;
  min?: string;
  meets?: boolean;
}
export interface EnvStatus {
  node?: { detected?: string; runtime?: string | null; path?: string | null };
  npm?: { detected?: string; runtime?: string | null; path?: string | null };
  git?: { detected?: string };
  ok?: boolean;
  npmRoot?: string | null;
  installedAt?: string | null;
  source?: string | null;
  catalog?: { ready?: boolean; items?: Record<string, EnvCatalogItem> };
  capabilities?: PlatformCapabilities | null;
  sandboxBudget?: SandboxBudget | null;
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
/** GET /env/node-lts；内核 src/app/settings/node-lts.js::nodeLtsStatus() 不做远端查询，本类型与之对齐。 */
export interface NodeLtsStatus {
  ok: boolean;
  current?: string | null;
  major?: number | null;
  ltsLine?: boolean | null;
  suggested?: string | null;
  fetchedAt?: number | null;
  cached?: boolean;
  error?: string | null;
}

export interface GenericOk { ok?: boolean; error?: string | null; [k: string]: unknown; }

/** 与内核 platform/os/browser.js 的 outcome 同字段。三档语义不得在界面合并：confirmed 拿到成功证据 /
 *  handedOff 只交出地址 / ok=false 明确失败；url 恒在场，任何一档都要能复制。 */
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
    ownsWindow?: boolean;
    isolated?: boolean;
    profile?: string | null;
    watch?: boolean;
    exitCode?: number | string | null;
    exitSignal?: string | null;
    error?: string | null;
    diagnostics?: BrowserDiagnostics | null;
    /** 内核 environment.js#checkEgress；null = 不涉及隔离窗口或表单未探测。 */
    egress?: EgressVerdict | null;
  } | null;
}

/** 三态结论：内核不得把「判不出」折成 false。 */
export interface EgressVerdict {
  host?: string | null;
  viable?: boolean | null;
  basis?: string;
  detail?: string | null;
  /** 系统代理读数 on/off/unknown；unknown 不等于 off。 */
  proxy?: string;
  at?: number | null;
}

/** 内核 platform/os/browser.js#launchDiagnostics 的产出，与 GET /env/environment 完整表单同源；面板只渲染它。 */
export interface BrowserDiagnostics {
  /** 内核 platform/os/environment.js#pickLauncher 的 how 字段：user-preference / candidate-rank / only-installed / none-found。 */
  pick?: string | null;
  default?: { id: string; source?: string | null } | null;
  preference?: { id?: string | null; matched?: boolean } | null;
  found?: Array<{ name?: string | null; engine?: string | null; via?: string }>;
  probed?: Array<{ source: string; detail?: string | number | null }>;
}

/** 内核 environment.js#form 的 sections 值；state 四档必须分开呈现（不得把 pending/empty/error 混成「没有」）。
 *  一律用 type 而非 interface：维度数据要当 Record 用，interface 拿不到隐式索引签名。 */
export type EnvironmentSection<T = Record<string, unknown>> = {
  label?: string;
  at?: number | null;
  source?: string;
  state?: 'ok' | 'empty' | 'error' | 'pending' | string;
  data?: T | null;
  error?: string | null;
  [k: string]: unknown;
};

export type EgressSectionData = {
  at?: number | null;
  proxy?: { state?: string; server?: string | null; pac?: string | null; source?: string; cached?: boolean } | null;
  targets?: Record<string, { ok?: boolean | null; stage?: string; detail?: string | null; at?: number | null }>;
  probed?: Array<{ source?: string; detail?: string | number | null }>;
};

export type RuntimeSectionData = {
  node?: Record<string, unknown> | null;
  npm?: Record<string, unknown> | null;
  git?: Record<string, unknown> | null;
  registry?: { origin?: string | null; mode?: string | null; source?: string | null; manualOrigin?: string | null;
    candidates?: Array<{ base?: string; reachable?: boolean | null; latencyMs?: number | null; error?: string | null }> } | null;
  prefix?: string | null;
};

export type DshSectionData = {
  dsh?: Record<string, unknown> | null;
  selfUpdate?: Record<string, unknown> | null;
  managed?: boolean;
  phase?: string | null;
};

export type StartupSectionData = {
  bootAt?: number | null;
  envDelayMs?: number | null;
  routerAutostart?: boolean | null;
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

/** 壳投放的环境报告（内核 platform/contract/shell-report.js 的读回产物）。available=false 要分清
 *  never-written 与 unreadable-or-schema-mismatch，后者是要去查文件的故障。 */
export type ShellSectionData = {
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

export type EnvironmentSections = {
  runtime?: EnvironmentSection<RuntimeSectionData>;
  shell?: EnvironmentSection<ShellSectionData>;
  dsh?: EnvironmentSection<DshSectionData>;
  egress?: EnvironmentSection<EgressSectionData>;
  startup?: EnvironmentSection<StartupSectionData>;
  [id: string]: EnvironmentSection | undefined;
};

/** 内核 platform/os/environment.js 的装配产物（GET /env/environment）。 */
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
  /** 异步维度只由 refresh() 拍，未拍即 state='pending'：不得拿空当结论。 */
  sections?: EnvironmentSections | undefined;
  probed?: Array<{ section?: string; source: string; detail?: string | number | null }>;
  snapshot?: { path?: string; written?: boolean; error?: string | null };
}

/** GET /env/environment/last（内核 environment.js#lastSnapshot）：只读留痕，不得与当拍字段合并。 */
export interface EnvironmentSnapshotRead {
  available?: boolean;
  path?: string;
  at?: number | null;
  ageMs?: number | null;
  reason?: 'ok' | 'never-written' | 'unreadable-or-schema-mismatch' | string;
  data?: EnvironmentForm | null;
}

/** GET|POST /settings/external-browser。 */
export interface ExternalBrowserStatus {
  ok?: boolean;
  error?: string | null;
  configured?: boolean;
  value?: string | null;
  stale?: boolean;
  browser?: { id: string; name?: string; engine?: string; isDefault?: boolean } | null;
  candidates?: Array<{ id: string; name?: string; engine?: string; isDefault?: boolean }>;
  pick?: { how?: string; id?: string | null; name?: string | null; wanted?: string | null; stale?: boolean } | null;
  platform?: string | null;
}

/** POST /router/proxy/login/start。isolated 与 isolatedBasis 必须成对读：「未隔离」可能是引擎无隔离方言，
 *  也可能是冷档案注定空白（cold-profile-blocked），处置不同（换浏览器 vs 配系统代理）。 */
export interface ProxyLoginStart extends OpenExternalResult {
  authUrl?: string;
  state?: string;
  port?: number;
  waitMs?: number;
  opened?: boolean;
  isolated?: boolean;
  isolatedBasis?: string;
  isolatedDetail?: string | null;
}

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
  // restartCount 不在此处：/status.restartCount = dsh，instance.state.restartCount = 沙箱。
  detail?: unknown;
}

