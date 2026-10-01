/** 唯一允许直接 fetch 的模块（页面经 services 层间接使用，GET 纯读）：http() 只看 HTTP 状态码，
 *  2xx 里的 { ok:false } 视为数据不抛，写操作假成功由 failureFromResult 判据；开发跨端口走 vite proxy 转发。 */
import type {
  AccessKeyResult, AccessKeyStatus, AutostartStatus, CloseActionStatus, EnvironmentForm, EnvironmentSnapshotRead, EnvStatus, EventsPage, ExternalBrowserStatus, FrpStatus, GenericOk,
  GuardVersion, InstancesResponse, InstalledPluginsResponse, LanAccessResponse,
  LanPanelStatus, LifecycleModuleId, MarketResponse, NodeLtsStatus, OpenExternalResult, PluginUpdatesResponse,
  PortsResponse, ProvidersResponse, ProxyLoginStart, RegistryInfo, RemoteMode, RouterStatus,
  PluginJobStatus, ProxyUpdateStatus, SelfUpdateStatus, SupervisorInstance, SupervisorStatus, TasksResponse,
  ShellStatus, ShellUpdateCheck,
} from "./types";

const BASE = "";

const DEFAULT_TIMEOUT_MS = 15_000;

// 后端 core/src/api/transport/server.js 对非回环请求 fail-closed：无匹配 key 一律 401（连静态页也被拦）。
// key 仅存本机 localStorage（绝不入仓库/日志），此后同源请求统一带 Bearer 头。
// 键名必须与单源 core/src/shared/brand.js#STORE_KEY_API_ACCESS 逐字一致（面板不能 require CommonJS 单源，
//   由 core/test/brand-single-source-test.js J 段解析本文件对账）；改名 ⇒ 已存密钥失效、非回环访问被拒。
const ACCESS_KEY_STORAGE = "lobox.apiAccessKey";

function readStoredAccessKey(): string {
  try { return globalThis.localStorage?.getItem(ACCESS_KEY_STORAGE) || ""; } catch { return ""; }
}

export function setStoredAccessKey(key: string): void {
  try {
    if (key) globalThis.localStorage?.setItem(ACCESS_KEY_STORAGE, key);
    else globalThis.localStorage?.removeItem(ACCESS_KEY_STORAGE);
  } catch { /* 隐私模式/webview 下 localStorage 会抛 */ }
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
export const LONG_TIMEOUT_MS = 210_000;

export interface HttpOptions { timeoutMs?: number; }

function withTimeout(ms: number): { signal: AbortSignal; clear: () => void } {
  const c = new AbortController();
  const id = setTimeout(() => c.abort(new DOMException("请求超时", "TimeoutError")), ms);
  return { signal: c.signal, clear: () => clearTimeout(id) };
}

/** 后端错误约定 {error|message}，缺省用 HTTP 状态 */
async function http<T>(method: string, path: string, body?: unknown, opts?: HttpOptions): Promise<T> {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const { signal, clear } = withTimeout(timeoutMs);
  const headers: Record<string, string> = {};
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
    err.status = res.status;
    // 响应体随错误一起交出：后端把「动作未被接受」映射为非 2xx，失败档的结构化字段（如外部打开的 url/reason）需呈现给用户。
    err.body = data;
    throw err;
  }
  return data as T;
}
const get = <T>(p: string, opts?: HttpOptions) => http<T>("GET", p, undefined, opts);
const post = <T>(p: string, body?: unknown, opts?: HttpOptions) => http<T>("POST", p, body ?? {}, opts);

/** 后端写端点形如 send(200, { ok: true, ...r })：r 自带 ok:false（如 /dist/registry/probe 非法 origin）会把 ok 覆盖成 false
 *  但 HTTP 仍 200，而 http() 只看状态码，故被拒操作需此处判据（供 useSupervisorAction.run 消费）。 */
export function failureFromResult(result: unknown): string | null {
  if (!result || typeof result !== "object") return null;
  const r = result as { ok?: unknown; error?: unknown; message?: unknown };
  if (r.ok !== false) return null;
  const msg = typeof r.error === "string" && r.error
    ? r.error
    : (typeof r.message === "string" && r.message ? r.message : "");
  return msg || "操作未被接受（后端返回 ok:false）";
}

/** 文本端点（text/plain，如 /changelog、/guard/changelog）：http() 按 JSON 解析会得到 null，故直接取原文。 */
async function getText(path: string): Promise<string> {
  const { signal, clear } = withTimeout(DEFAULT_TIMEOUT_MS);
  const headers: Record<string, string> = {};
  const ak = readStoredAccessKey();
  if (ak) headers["Authorization"] = "Bearer " + ak;
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
  status: () => get<SupervisorStatus>("/status"),
  // /session/status 是壳（Rust get_session_state）与外部脚本的读取口；UI 不发额外请求，会话态随 /status（2s 轮询）以 sessionState 字段返回。
  events: (after = 0, limit = 60) => get<EventsPage>(qs("/events", { after, limit })),
  instances: () => get<InstancesResponse>("/instances"),
  lanAccess: () => get<LanAccessResponse>("/lan-access"),
  frp: () => get<FrpStatus>("/remote/frp"),
  routerStatus: () => get<RouterStatus>("/router/status"),
  providers: () => get<ProvidersResponse>("/router/providers"),
  tasks: () => get<TasksResponse>("/tasks"),
  ports: () => get<PortsResponse>("/ports"),
  lifecycleStart: (id: LifecycleModuleId) => post<GenericOk & { ok?: boolean }>("/lifecycle/" + id + "/start"),
  lifecycleStop: (id: LifecycleModuleId) => post<GenericOk & { ok?: boolean }>("/lifecycle/" + id + "/stop"),

  nativeCheckUpdate: () => post<GenericOk & { updateAvailable?: boolean; latest?: string; installed?: string | null }>("/native/check-update"),
  nativeInstall: () => post<GenericOk>("/native/install"),
  nativeUpgrade: (version?: string) => post<GenericOk>("/native/upgrade", version ? { version } : {}),
  nativeUninstall: () => post<GenericOk>("/native/uninstall"),
  // 原生主干 main 设置走 /native/settings（非 /instances 沙箱域），仅 guardian；远程控制（模式/令牌）唯一入口在 remote* 系列（main 与沙箱同口）。
  nativeSettings: (patch: { guardian?: boolean }) =>
    post<GenericOk & { main?: SupervisorInstance }>("/native/settings", patch),

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

  providerAdd: (p: { name?: string; presetId?: string; kind?: string; appId?: string; keys?: string[] }) =>
    post<GenericOk & { id?: string }>("/router/providers/add", p),
  providerRemove: (id: string) => post<GenericOk>("/router/providers/remove", { id }),
  providerActivate: (id: string) => post<GenericOk>("/router/providers/activate", { id }),
  providerDeactivate: (id: string) => post<GenericOk>("/router/providers/deactivate", { id }),
  providerRefresh: (id: string) => post<GenericOk>("/router/providers/refresh", { id }),
  providerKeysSet: (id: string, p: { removeMasked?: string[]; add?: string[] }) =>
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
  // proxyLoginWait 是服务端轮询等待（最长可 waitMs~180s）：请求超时需覆盖等待窗口 + 网络余量
  proxyLoginWait: (timeoutMs: number) => post<GenericOk & { apiKey?: string }>("/router/proxy/login/wait", { timeoutMs }, { timeoutMs: Math.max(LONG_TIMEOUT_MS, timeoutMs + 30_000) }),
  proxyUpdateCheck: () => post<GenericOk>("/router/proxy/update/check"),
  proxyUpdateApply: (appId: string) => post<GenericOk>("/router/proxy/update/apply", { appId }),
  proxyUpdateStatus: (appId: string) => get<ProxyUpdateStatus>(qs("/router/proxy/update/status", { appId })),

  // 市场索引/更新检测均为「立即回快照 + 后台跑」：building/refreshing 为真时调用方要轮询，不能等在这个请求上。
  market: (force = false) => get<MarketResponse>("/plugins/market" + (force ? "?refresh=1" : "")),
  pluginsInstalled: () => get<InstalledPluginsResponse>("/plugins/installed"),
  pluginsCheckUpdates: (force = false) => get<PluginUpdatesResponse>("/plugins/check-updates" + (force ? "?refresh=1" : "")),
  pluginInstall: (spec: string, target: string) => post<GenericOk & { jobId?: string }>("/plugins/install", { spec, target }),
  pluginEnable: (name: string) => post<GenericOk>("/plugins/enable", { name, target: "all" }),
  pluginDisable: (name: string) => post<GenericOk>("/plugins/disable", { name, target: "all" }),
  pluginUpdate: (name: string) => post<GenericOk & { jobId?: string }>("/plugins/update", { name, target: "all" }),
  pluginUninstall: (name: string) => post<GenericOk & { jobId?: string }>("/plugins/uninstall", { name, target: "all" }),
  pluginInstallStatus: (jobId: string) => get<PluginJobStatus>(qs("/plugins/install-status", { job: jobId })),

  /** 远程控制唯一写入口：三态 off|lan|wan；缺令牌由后端自动分配（回执 tokenAutoAllocated），wan 拒因在响应 error。 */
  remoteSetMode: (id: string, mode: RemoteMode) => post<GenericOk & { tokenAutoAllocated?: boolean }>("/remote/set-mode", { id, mode }),
  /** 访问令牌唯一写入口（空串=清除）。 */
  remoteSetToken: (id: string, token: string) => post<GenericOk>("/remote/set-token", { id, token }),
  // frps 连接配置：authToken 留空时必须整体缺省该字段（提交 '' 会被后端清除现值）。
  remoteFrpServer: (s: { serverAddr: string; serverPort: number; authToken?: string }) =>
    post<GenericOk>("/remote/frp-server", s),
  remoteFrpInstall: () => post<GenericOk>("/remote/frp-install"),

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
  /** 同源探活由服务端执行：页面 CSP connect-src 'self' 会拦截浏览器直连用户填的镜像。 */
  registryProbe: (origin: string) => post<GenericOk & { origin: string; ok: boolean; latencyMs: number | null; probe?: string }>("/dist/registry/probe", { origin }),
  /** 内核更新状态（只读）：安装/重启由桌面壳执行（单写入者契约，见 kernelUpdateBridge）。 */
  selfUpdateStatus: () => get<SelfUpdateStatus>("/self-update/status"),
  guardVersion: () => get<GuardVersion>("/guard/version"),
  guardVersionCheck: () => post<GuardVersion & { ok?: boolean }>("/guard/version/check"),
  shellStatus: () => get<ShellStatus>("/shell/status"),
  shellCheckUpdate: () => post<ShellUpdateCheck>("/shell/check-update"),
  shellRestart: () => post<GenericOk>("/shell/restart"),
  // /changelog 返回 text/plain（DSH 版本信息 + 升级指引 + Releases 链接）。
  dshChangelog: () => getText("/changelog"),
  // 管家更新日志：本地 CHANGELOG.md 原文。
  guardChangelog: () => getText("/guard/changelog"),
  envStatus: () => get<EnvStatus>("/env/status"),
  nodeLts: () => get<NodeLtsStatus>("/env/node-lts"),
  /** 请内核用它所在机器的默认浏览器打开地址（外部打开唯一出口；三档结果原样回传）。 */
  envOpenUrl: (url: string) => post<OpenExternalResult>("/env/open-url", { url }),
  /** 内核所在机器环境实况 + 外部打开的分发依据；force=true 绕开内核 60s 缓存重探（刚装/卸载浏览器后用）。 */
  environment: (force = false) => get<EnvironmentForm>(`/env/environment${force ? "?force=1" : ""}`),
  environmentLast: () => get<EnvironmentSnapshotRead>("/env/environment/last"),
  externalBrowser: () => get<ExternalBrowserStatus>("/settings/external-browser"),
  /** id 必须是候选清单里的 id；空串=清除，回到按系统默认/候选次序分发。 */
  setExternalBrowser: (id: string) => post<GenericOk & ExternalBrowserStatus>("/settings/external-browser", { id }),
};
