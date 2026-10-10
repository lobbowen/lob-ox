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

const ACCESS_KEY_STORAGE = "lobox.apiAccessKey";

function readStoredAccessKey(): string {
  try { return globalThis.localStorage?.getItem(ACCESS_KEY_STORAGE) || ""; } catch { return ""; }
}

export function setStoredAccessKey(key: string): void {
  try {
    if (key) globalThis.localStorage?.setItem(ACCESS_KEY_STORAGE, key);
    else globalThis.localStorage?.removeItem(ACCESS_KEY_STORAGE);
  } catch {  }
}

(() => {
  try {
    const g = globalThis as unknown as { location?: Location; history?: History };
    if (!g.location || !g.history) return;
    const k = new URLSearchParams(g.location.search || "").get("access_key");
    if (!k) return;
    setStoredAccessKey(k);
    g.history.replaceState(null, "", g.location.pathname + g.location.hash);
  } catch {  }
})();
export const LONG_TIMEOUT_MS = 210_000;

export interface HttpOptions { timeoutMs?: number; }

function withTimeout(ms: number): { signal: AbortSignal; clear: () => void } {
  const c = new AbortController();
  const id = setTimeout(() => c.abort(new DOMException("请求超时", "TimeoutError")), ms);
  return { signal: c.signal, clear: () => clearTimeout(id) };
}

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
  try { data = await res.json(); } catch {  }
  if (!res.ok) {
    const d = data as { error?: string; message?: string } | null;
    const msg = d?.error || d?.message || `HTTP ${res.status} ${path}`;
    const err = new Error(
      res.status === 401
        ? msg + "（访问密钥缺失或已更新：请用带 ?access_key= 的链接重新进入，或在本机 127.0.0.1 面板重新保存密钥）"
        : msg,
    ) as Error & { status?: number; body?: unknown };
    err.status = res.status;
    
    err.body = data;
    throw err;
  }
  return data as T;
}
const get = <T>(p: string, opts?: HttpOptions) => http<T>("GET", p, undefined, opts);
const post = <T>(p: string, body?: unknown, opts?: HttpOptions) => http<T>("POST", p, body ?? {}, opts);

export function failureFromResult(result: unknown): string | null {
  if (!result || typeof result !== "object") return null;
  const r = result as { ok?: unknown; error?: unknown; message?: unknown };
  if (r.ok !== false) return null;
  const msg = typeof r.error === "string" && r.error
    ? r.error
    : (typeof r.message === "string" && r.message ? r.message : "");
  return msg || "操作未被接受（后端返回 ok:false）";
}

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
  
  proxyLoginWait: (timeoutMs: number) => post<GenericOk & { apiKey?: string }>("/router/proxy/login/wait", { timeoutMs }, { timeoutMs: Math.max(LONG_TIMEOUT_MS, timeoutMs + 30_000) }),
  proxyUpdateCheck: () => post<GenericOk>("/router/proxy/update/check"),
  proxyUpdateApply: (appId: string) => post<GenericOk>("/router/proxy/update/apply", { appId }),
  proxyUpdateStatus: (appId: string) => get<ProxyUpdateStatus>(qs("/router/proxy/update/status", { appId })),

  
  market: (force = false) => get<MarketResponse>("/plugins/market" + (force ? "?refresh=1" : "")),
  pluginsInstalled: () => get<InstalledPluginsResponse>("/plugins/installed"),
  pluginsCheckUpdates: (force = false) => get<PluginUpdatesResponse>("/plugins/check-updates" + (force ? "?refresh=1" : "")),
  pluginInstall: (spec: string, target: string) => post<GenericOk & { jobId?: string }>("/plugins/install", { spec, target }),
  pluginEnable: (name: string) => post<GenericOk>("/plugins/enable", { name, target: "all" }),
  pluginDisable: (name: string) => post<GenericOk>("/plugins/disable", { name, target: "all" }),
  pluginUpdate: (name: string) => post<GenericOk & { jobId?: string }>("/plugins/update", { name, target: "all" }),
  pluginUninstall: (name: string) => post<GenericOk & { jobId?: string }>("/plugins/uninstall", { name, target: "all" }),
  pluginInstallStatus: (jobId: string) => get<PluginJobStatus>(qs("/plugins/install-status", { job: jobId })),

  
  remoteSetMode: (id: string, mode: RemoteMode) => post<GenericOk & { tokenAutoAllocated?: boolean }>("/remote/set-mode", { id, mode }),
  
  remoteSetToken: (id: string, token: string) => post<GenericOk>("/remote/set-token", { id, token }),
  
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
  
  registryProbe: (origin: string) => post<GenericOk & { origin: string; ok: boolean; latencyMs: number | null; probe?: string }>("/dist/registry/probe", { origin }),
  
  selfUpdateStatus: () => get<SelfUpdateStatus>("/self-update/status"),
  guardVersion: () => get<GuardVersion>("/guard/version"),
  guardVersionCheck: () => post<GuardVersion & { ok?: boolean }>("/guard/version/check"),
  shellStatus: () => get<ShellStatus>("/shell/status"),
  shellCheckUpdate: () => post<ShellUpdateCheck>("/shell/check-update"),
  shellRestart: () => post<GenericOk>("/shell/restart"),
  
  dshChangelog: () => getText("/changelog"),
  
  guardChangelog: () => getText("/guard/changelog"),
  envStatus: () => get<EnvStatus>("/env/status"),
  nodeLts: () => get<NodeLtsStatus>("/env/node-lts"),
  
  envOpenUrl: (url: string) => post<OpenExternalResult>("/env/open-url", { url }),
  
  environment: (force = false) => get<EnvironmentForm>(`/env/environment${force ? "?force=1" : ""}`),
  environmentLast: () => get<EnvironmentSnapshotRead>("/env/environment/last"),
  externalBrowser: () => get<ExternalBrowserStatus>("/settings/external-browser"),
  
  setExternalBrowser: (id: string) => post<GenericOk & ExternalBrowserStatus>("/settings/external-browser", { id }),
};
