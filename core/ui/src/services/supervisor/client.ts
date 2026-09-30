/** supervisor HTTP API 客户端（同源 fetch，生产由 dsh-supervisor 托管）：唯一允许直接 fetch 的模块，页面经 services 层间接使用，GET 纯读；
 *  http() 只看 HTTP 状态码，2xx 里的 { ok:false } 视为数据（如探活不通）不抛，写操作假成功由 failureFromResult 统一判据（UI 条 5）；
 *  生产同源（/…），开发跨端口用 vite proxy 转发（去掉 Origin 走回环）。 */
import type {
  AccessKeyResult, AccessKeyStatus, AutostartStatus, CloseActionStatus, EnvironmentForm, EnvironmentSnapshotRead, EnvStatus, EventsPage, ExternalBrowserStatus, FrpStatus, GenericOk,
  GuardVersion, InstancesResponse, InstalledPluginsResponse, LanAccessResponse,
  LanPanelStatus, LifecycleModuleId, MarketResponse, NodeLtsStatus, OpenExternalResult, PluginUpdatesResponse,
  PortsResponse, ProvidersResponse, ProxyLoginStart, RegistryInfo, RemoteMode, RouterStatus,
  PluginJobStatus, ProxyUpdateStatus, SelfUpdateStatus, SupervisorInstance, SupervisorStatus, TasksResponse,
  ShellStatus, ShellUpdateCheck,
} from "./types";

// API 根：面板由守卫内核同源托管（壳按 config.apiPort 动态给 URL，无硬编码端口/无透传）。
const BASE = "";

/** 默认请求超时：轮询 read 与本地写操作均应在该窗口内完成；慢网下由轮询层 in-flight 守卫兜底。 */
const DEFAULT_TIMEOUT_MS = 15_000;

// -- 访问密钥 ------------------------------------------
// 后端 api/transport/server.js 对非回环请求 fail-closed：无匹配 key 一律 401（连静态页也被拦）。
// key 仅存本机 localStorage（绝不入仓库/日志）。bootstrap：首次以 http://<lan>:<port>/?access_key=KEY
// 访问时，模块加载即把 key 从 URL 搬入存储并 replaceState 抹掉参数（不留历史），此后同源请求统一带 Bearer 头。
const ACCESS_KEY_STORAGE = "dsh.apiAccessKey";

function readStoredAccessKey(): string {
  try { return globalThis.localStorage?.getItem(ACCESS_KEY_STORAGE) || ""; } catch { return ""; }
}

/** 写入/清除本机缓存的访问密钥（空串=清除）。存储不可用时静默降级。 */
export function setStoredAccessKey(key: string): void {
  try {
    if (key) globalThis.localStorage?.setItem(ACCESS_KEY_STORAGE, key);
    else globalThis.localStorage?.removeItem(ACCESS_KEY_STORAGE);
  } catch { /* 隐私模式/webview 限制：退化为无 key，401 由轮询层显式呈现 */ }
}

(() => {
  try {
    const g = globalThis as unknown as { location?: Location; history?: History };
    if (!g.location || !g.history) return;
    const k = new URLSearchParams(g.location.search || "").get("access_key");
    if (!k) return;
    setStoredAccessKey(k);
    g.history.replaceState(null, "", g.location.pathname + g.location.hash);
  } catch { /* 非浏览器环境 */ }
})();
/** 长耗时端点的超时覆盖（如 proxyLoginWait 本身就是服务端轮询等待，需留足等待窗口） */
export const LONG_TIMEOUT_MS = 210_000;

export interface HttpOptions { timeoutMs?: number; }

/** AbortController 计时器：超时即 abort 并附可读错误；finally 里 clear 防泄漏 */
function withTimeout(ms: number): { signal: AbortSignal; clear: () => void } {
  const c = new AbortController();
  const id = setTimeout(() => c.abort(new DOMException("请求超时", "TimeoutError")), ms);
  return { signal: c.signal, clear: () => clearTimeout(id) };
}

/** 统一错误提取：后端约定 {error|message}，缺省 HTTP 状态 */
async function http<T>(method: string, path: string, body?: unknown, opts?: HttpOptions): Promise<T> {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // 同源/壳内直连 fetch（守卫托管同源，或壳 asset 源走 CORS 白名单）；统一浏览器 fetch 路径
  const { signal, clear } = withTimeout(timeoutMs);
  const headers: Record<string, string> = {};
  // 本机存过访问密钥就统一带 Bearer（回环请求后端本就豁免，多带无害且换 IP 访问零配置）。
  const ak = readStoredAccessKey();
  if (ak) headers["Authorization"] = "Bearer " + ak;
  const init: RequestInit = { method, headers, signal };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  let res: Response;
  try {
    res = await fetch(BASE + path, init);
  } catch (e) {
    if (e instanceof DOMException && e.name === "TimeoutError") {
      throw new Error(`请求超时（${Math.round(timeoutMs / 1000)}s）：${path}`, { cause: e });
    }
    throw e;
  } finally {
    clear();
  }
  let data: unknown = null;
  try { data = await res.json(); } catch { /* 文本/空响应 */ }
  if (!res.ok) {
    const d = data as { error?: string; message?: string } | null;
    const msg = d?.error || d?.message || `HTTP ${res.status} ${path}`;
    const err = new Error(
      res.status === 401
        ? msg + "（访问密钥缺失或已更新：请用带 ?access_key= 的链接重新进入，或在本机 127.0.0.1 面板重新保存密钥）"
        : msg,
    ) as Error & { status?: number; body?: unknown };
    err.status = res.status; // 轮询层据此区分「401 鉴权失败」与「真离线」
    // 响应体随错误一起交出：后端把「动作未被接受」映射为非 2xx（GD 条），而有些结果的
    // 结构化字段（如外部打开的 url/reason）必须呈现给用户，只留一句文案就丢了可复制的地址。
    err.body = data;
    throw err;
  }
  return data as T;
}
const get = <T>(p: string, opts?: HttpOptions) => http<T>("GET", p, undefined, opts);
const post = <T>(p: string, body?: unknown, opts?: HttpOptions) => http<T>("POST", p, body ?? {}, opts);

/** 从 2xx 响应体里提取失败原因。
 *  后端多个写端点形如 send(200, { ok: true, ...r })，当 r 自带 ok:false（如 /dist/registry/probe 非法 origin）
 *  会把 ok 覆盖成 false 但 HTTP 仍 200，而 http() 只看状态码，故被拒操作需此处判据（供 useSupervisorAction.run 消费）。
 *  返回 null = 不是这种失败形态（result 为 null/非对象/无 ok 键）。 */
export function failureFromResult(result: unknown): string | null {
  if (!result || typeof result !== "object") return null;
  const r = result as { ok?: unknown; error?: unknown; message?: unknown };
  if (r.ok !== false) return null;
  const msg = typeof r.error === "string" && r.error
    ? r.error
    : (typeof r.message === "string" && r.message ? r.message : "");
  return msg || "操作未被接受（后端返回 ok:false）";
}

/** 文本端点（text/plain，如 /changelog、/guard/changelog）：http() 会尝试 JSON 解析失败后返回 null，
 *  故此处直接走 fetch 取原文（保持同源/CSP 与超时语义一致）。 */
async function getText(path: string): Promise<string> {
  const { signal, clear } = withTimeout(DEFAULT_TIMEOUT_MS);
  const headers: Record<string, string> = {};
  const ak = readStoredAccessKey();
  if (ak) headers["Authorization"] = "Bearer " + ak; // 文本端点同过后端 401 门卫
  try {
    const res = await fetch(BASE + path, { method: "GET", headers, signal });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status} ${path}`);
    return text;
  } finally { clear(); }
}

function qs(base: string, params: Record<string, string | number | undefined>) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") sp.set(k, String(v));
  const s = sp.toString();
  return s ? base + "?" + s : base;
}

export const supervisorApi = {
  // -- 运行态 --
  status: () => get<SupervisorStatus>("/status"),
  // 注：/session/status 是壳（Rust get_session_state）与外部脚本的读取口；UI 不发额外请求，
  // 会话态已随 /status（2s 轮询）以 sessionState 字段投影返回（避免双路径）。
  events: (after = 0, limit = 60) => get<EventsPage>(qs("/events", { after, limit })),
  instances: () => get<InstancesResponse>("/instances"),
  lanAccess: () => get<LanAccessResponse>("/lan-access"),
  frp: () => get<FrpStatus>("/remote/frp"),
  routerStatus: () => get<RouterStatus>("/router/status"),
  providers: () => get<ProvidersResponse>("/router/providers"),
  tasks: () => get<TasksResponse>("/tasks"),
  ports: () => get<PortsResponse>("/ports"),
  // -- 统一生命周期：模块启停/状态走单一控制路径 /lifecycle/{id}/…，后端语义等价且 daemon 监督感知 --
  lifecycleStart: (id: LifecycleModuleId) => post<GenericOk & { ok?: boolean }>("/lifecycle/" + id + "/start"),
  lifecycleStop: (id: LifecycleModuleId) => post<GenericOk & { ok?: boolean }>("/lifecycle/" + id + "/stop"),
  // 注：GET /lifecycle/{id} 保留为后端 REST 面（单模块查询，供脚本/curl）；UI 未使用故不设 client 方法。

  // -- native DSH --
  nativeCheckUpdate: () => post<GenericOk & { updateAvailable?: boolean; latest?: string; installed?: string | null }>("/native/check-update"),
  nativeInstall: () => post<GenericOk>("/native/install"),
  nativeUpgrade: (version?: string) => post<GenericOk>("/native/upgrade", version ? { version } : {}),
  nativeUninstall: () => post<GenericOk>("/native/uninstall"),
  // 原生主干 main 设置走 /native/settings（非 /instances 沙箱域），仅 guardian；
  // 远程控制意图（模式/令牌）唯一入口在 remote* 系列（main 与沙箱同口）。
  nativeSettings: (patch: { guardian?: boolean }) =>
    post<GenericOk & { main?: SupervisorInstance }>("/native/settings", patch),

  // -- instances --
  instanceAdd: (p: { name: string; port: number; command?: string[] }) =>
    post<GenericOk>("/instances/add", p),
  instanceUpdate: (id: string, patch: { guardian?: boolean }) =>
    post<GenericOk>("/instances/update", { id, ...patch }),
  instanceRemove: (id: string) => post<GenericOk & { dataPreserved?: boolean; preserveReason?: string }>("/instances/remove", { id }),
  instanceStart: (id: string) => post<GenericOk>("/instances/start", { id }),
  instanceStop: (id: string) => post<GenericOk>("/instances/stop", { id }),
  instanceOpenWeb: (id: string) => post<OpenExternalResult>("/instances/open-web", { id }),
  instanceCheckUpdate: (id: string) => post<GenericOk & { updateAvailable?: boolean; latest?: string; installed?: string }>("/instances/check-update", { id }),
  instanceUpgrade: (id: string) => post<GenericOk>("/instances/upgrade", { id }),

  // -- router（模块启停已并入 /lifecycle/router/…；下方为供应商/账号管理端点）--
  providerAdd: (p: { name?: string; presetId?: string; kind?: string; appId?: string; keys?: string[] }) =>
    post<GenericOk & { id?: string }>("/router/providers/add", p),
  providerRemove: (id: string) => post<GenericOk>("/router/providers/remove", { id }),
  providerActivate: (id: string) => post<GenericOk>("/router/providers/activate", { id }),
  providerDeactivate: (id: string) => post<GenericOk>("/router/providers/deactivate", { id }),
  providerRefresh: (id: string) => post<GenericOk>("/router/providers/refresh", { id }),
  providerKeysSet: (id: string, p: { removeMasked?: string[]; add?: string[] }) =>
    // 后端回报被丢弃的 Key 及原因（discarded/discardedKeys），UI 据此提示部分失败，而非一律报成功。
    post<GenericOk & {
      added?: number; removed?: number;
      discarded?: number; discardedKeys?: { key: string; error: string }[];
    }>("/router/providers/keys/set", { id, ...p }),
  providerKeyUse: (id: string, fingerprint: string) =>
    post<GenericOk & { active?: string }>("/router/providers/key/use", { id, fingerprint }),
  providerAccountDiscard: (id: string, keyId: string) => post<GenericOk>("/router/providers/account/discard", { id, keyId }),
  proxyAddKey: (id: string, key: string) => post<GenericOk>("/router/providers/proxy/key", { id, key }),
  proxyRemoveKey: (id: string, keyId: string) => post<GenericOk>("/router/providers/proxy/key/remove", { id, keyId }),
  proxySelect: (id: string, keyId: string) => post<GenericOk>("/router/providers/proxy/select", { id, keyId }),
  proxyLoginStart: () => post<ProxyLoginStart>("/router/proxy/login/start"),
  // 服务端轮询等待（最长可 waitMs~180s）：请求超时需覆盖等待窗口 + 网络余量
  proxyLoginWait: (timeoutMs: number) => post<GenericOk & { apiKey?: string }>("/router/proxy/login/wait", { timeoutMs }, { timeoutMs: Math.max(LONG_TIMEOUT_MS, timeoutMs + 30_000) }),
  proxyUpdateCheck: () => post<GenericOk>("/router/proxy/update/check"),
  proxyUpdateApply: (appId: string) => post<GenericOk>("/router/proxy/update/apply", { appId }),
  // 反代更新进度：job 模型，前端轮询消除黑盒；steps 逐实例，支持多实例依次更新的进度可视化。
  proxyUpdateStatus: (appId: string) => get<ProxyUpdateStatus>(qs("/router/proxy/update/status", { appId })),

  // -- plugins --
  // 市场索引/更新检测均为「立即回快照 + 后台跑」：响应里 building/refreshing 为真时调用方要轮询，
  // 而不是把长动作等在这个请求上（默认 15s 计时会先放弃，而服务端仍会跑完）。
  market: (force = false) => get<MarketResponse>("/plugins/market" + (force ? "?refresh=1" : "")),
  pluginsInstalled: () => get<InstalledPluginsResponse>("/plugins/installed"),
  pluginsCheckUpdates: (force = false) => get<PluginUpdatesResponse>("/plugins/check-updates" + (force ? "?refresh=1" : "")),
  pluginInstall: (spec: string, target: string) => post<GenericOk & { jobId?: string }>("/plugins/install", { spec, target }),
  pluginEnable: (name: string) => post<GenericOk>("/plugins/enable", { name, target: "all" }),
  pluginDisable: (name: string) => post<GenericOk>("/plugins/disable", { name, target: "all" }),
  pluginUpdate: (name: string) => post<GenericOk & { jobId?: string }>("/plugins/update", { name, target: "all" }),
  pluginUninstall: (name: string) => post<GenericOk & { jobId?: string }>("/plugins/uninstall", { name, target: "all" }),
  // 插件任务进度（job 模型）：install/update/uninstall 返回 jobId，前端轮询到 done/failed 消除黑盒
  pluginInstallStatus: (jobId: string) => get<PluginJobStatus>(qs("/plugins/install-status", { job: jobId })),

  // -- 远程控制（/remote/*：main 与沙箱同口，按 id 路由）--
  /** 远程控制唯一写入口：三态 off|lan|wan。开启时缺令牌由后端自动分配（回执 tokenAutoAllocated），
   *  wan 的拒因在响应 error（如已有过弱令牌）。 */
  remoteSetMode: (id: string, mode: RemoteMode) => post<GenericOk & { tokenAutoAllocated?: boolean }>("/remote/set-mode", { id, mode }),
  /** 访问令牌唯一写入口（空串=清除）。 */
  remoteSetToken: (id: string, token: string) => post<GenericOk>("/remote/set-token", { id, token }),
  // frps 连接配置：authToken 留空时必须整体缺省该字段（提交 '' 会被后端清除现值）。
  remoteFrpServer: (s: { serverAddr: string; serverPort: number; authToken?: string }) =>
    post<GenericOk>("/remote/frp-server", s),
  remoteFrpInstall: () => post<GenericOk>("/remote/frp-install"),

  // -- settings / env / guard / registry --
  autostart: () => get<AutostartStatus>("/autostart"),
  setAutostart: (enabled: boolean) => post<GenericOk>("/autostart", { enabled }),
  lanPanel: () => get<LanPanelStatus>("/settings/lan"),
  setLanPanel: (enabled: boolean) => post<GenericOk & LanPanelStatus>("/settings/lan", { enabled }),
  accessKey: () => get<AccessKeyStatus>("/settings/access-key"),
  setAccessKey: (key: string) => post<AccessKeyResult>("/settings/access-key", { key }),
  closeAction: () => get<CloseActionStatus>("/settings/close-action"),
  setCloseAction: (closeAction: "hide" | "exit") => post<GenericOk & CloseActionStatus>("/settings/close-action", { closeAction }),
  registry: () => get<RegistryInfo>("/dist/registry"),
  registrySet: (p: { mode: "auto" | "manual"; origins: string[]; manualOrigin?: string }) =>
    post<GenericOk & RegistryInfo>("/dist/registry/set", p),
  registryRefresh: () => post<GenericOk & RegistryInfo>("/dist/registry/refresh"),
  /** 同源单源探活：由服务端探测，不受页面 CSP connect-src 'self' 约束（浏览器直连用户填的镜像会被拦截）。 */
  registryProbe: (origin: string) => post<GenericOk & { origin: string; ok: boolean; latencyMs: number | null; probe?: string }>("/dist/registry/probe", { origin }),
  /** 内核更新状态（只读）：安装/重启由桌面壳执行（单写入者契约，见 kernelUpdateBridge）。 */
  selfUpdateStatus: () => get<SelfUpdateStatus>("/self-update/status"),
  guardVersion: () => get<GuardVersion>("/guard/version"),
  guardVersionCheck: () => post<GuardVersion & { ok?: boolean }>("/guard/version/check"),
  // -- 桌面壳（Tauri 壳）：版本检测 + 重启以应用更新--
  shellStatus: () => get<ShellStatus>("/shell/status"),
  shellCheckUpdate: () => post<ShellUpdateCheck>("/shell/check-update"),
  /** 重启桌面壳：壳的自更新发生在启动时（门 0），故「应用壳更新」= 重启壳。 */
  shellRestart: () => post<GenericOk>("/shell/restart"),
  // /changelog 返回 text/plain（DSH 版本信息 + 升级指引 + Releases 链接）。
  dshChangelog: () => getText("/changelog"),
  // 管家自身更新日志：本地 CHANGELOG.md 原文。
  guardChangelog: () => getText("/guard/changelog"),
  envStatus: () => get<EnvStatus>("/env/status"),
  nodeLts: () => get<NodeLtsStatus>("/env/node-lts"),
  /** 请内核用它所在机器的默认浏览器打开地址（外部打开唯一出口；三档结果原样回传）。
   *  非 2xx 时 http() 把响应体挂在 err.body 上，失败档的 url 才有抵达面板的路。 */
  envOpenUrl: (url: string) => post<OpenExternalResult>("/env/open-url", { url }),
  /** 环境表单（内核所在机器的实况 + 外部打开的分发依据）：面板「环境检测」据此显示候选、
   *  默认项来源与每一层判定。force=true 绕开内核 60s 缓存重探（刚装/卸载浏览器后用）。 */
  environment: (force = false) => get<EnvironmentForm>(`/env/environment${force ? "?force=1" : ""}`),
  /** 上一拍落盘快照的只读回看（零摸网零写盘）。与 environment() 分开调、分开失败：
   *  这份读不出只说明留痕断了，不该把刚探出来的当拍表单一起判成不可用。 */
  environmentLast: () => get<EnvironmentSnapshotRead>("/env/environment/last"),
  /** 外部打开的浏览器偏好：当前值 + 候选清单（候选来自环境表单，与分发同源）。 */
  externalBrowser: () => get<ExternalBrowserStatus>("/settings/external-browser"),
  /** 设置偏好（空串=清除，回到按系统默认/候选次序分发）。id 必须是候选清单里的 id。 */
  setExternalBrowser: (id: string) => post<GenericOk & ExternalBrowserStatus>("/settings/external-browser", { id }),
};
