import { supervisorApi } from "./client";
import type {
  EventsPage, FrpStatus, InstancesResponse, LanAccessResponse,
  PortsResponse, ProvidersResponse, RouterStatus, SupervisorStatus,
} from "./types";

export interface SupervisorSnapshot {
  status: SupervisorStatus | null;
  instances: InstancesResponse | null;
  lan: LanAccessResponse | null;
  frp: FrpStatus | null;
  router: RouterStatus | null;
  providers: ProvidersResponse | null;
  ports: PortsResponse | null;
  events: EventsPage["events"];
  eventsSeq: number;
  online: boolean;
  /** 本拍读失败的 endpoint 名：online 只看 status，其余面板挂掉时用户必须看得出是哪几个坏了。 */
  degraded: string[];
  authFailed: boolean;
}

function empty(): SupervisorSnapshot {
  return {
    status: null, instances: null, lan: null, frp: null,
    router: null, providers: null, ports: null,
    events: [], eventsSeq: 0, online: false, degraded: [], authFailed: false,
  };
}

type Listener = (snap: SupervisorSnapshot) => void;
const listeners = new Set<Listener>();
let snap = empty();
let started = false;
let timer: ReturnType<typeof setTimeout> | null = null;
let busy = false;
let eventsBusy = false;
/** start 新建、stop 先 abort：在途请求真的被取消，卸载后不可能再写状态。 */
let cycle: AbortController | null = null;
/** refresh 只置位：动作后必有新鲜一拍，且不会因 busy 早退被丢弃。 */
let refreshPending = false;

const BASE_TICK_MS = 2000;
const MAX_TICK_MS = 30_000;
let failStreak = 0;

function tickDelayMs(): number {
  if (failStreak <= 1) return BASE_TICK_MS;
  return Math.min(MAX_TICK_MS, BASE_TICK_MS * 2 ** (failStreak - 1));
}

function safeSeq(v: unknown, fallback: number): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function emit() { for (const l of listeners) l(snap); }

/**
 * 逐字段浅比较：内容没变就返回 false。
 *
 * 这是「每 2 秒整棵树重渲染」的唯一成因：setPartial 无条件 emit，
 * useSyncExternalStore 的 getSnapshot 每次返回新对象引用，React 即判定 store 已变，
 * 于是即便 8 个 endpoint 的响应字节完全相同，整棵组件树仍会重渲染一遍。
 * 面板内部还有各自的定时重渲染（事件流、时钟），叠加后表现为界面持续闪动。
 *
 * 注意必须逐字段比较而不是只比引用：{...snap, ...p} 每次都产生新对象，
 * 引用比较永远为 false，等于没有比较。
 */
function changed(prev: SupervisorSnapshot, next: SupervisorSnapshot): boolean {
  const keys = Object.keys(next) as (keyof SupervisorSnapshot)[];
  for (const k of keys) {
    const a = prev[k];
    const b = next[k];
    if (a === b) continue;
    // 数组按元素逐个比（事件列表每拍都会是新数组，但内容常常完全一致）
    if (Array.isArray(a) && Array.isArray(b)) {
      if (a.length !== b.length) return true;
      for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return true;
      continue;
    }
    return true;
  }
  return false;
}

function setPartial(p: Partial<SupervisorSnapshot>) {
  const next = { ...snap, ...p };
  if (!changed(snap, next)) return;   // 内容未变：不换引用、不通知订阅者
  snap = next;
  emit();
}

let epoch = 0;

async function heartbeat() {
  const mine = epoch;
  await Promise.all([refreshEvents(), syncAll()]);
  if (mine !== epoch || !started) return;
  timer = setTimeout(() => { void heartbeat(); }, tickDelayMs());
}

async function syncAll() {
  if (busy) { refreshPending = true; return; }
  busy = true;
  try {
    let authHit = false;
    const degraded: string[] = [];
    const onReadError = (name: string) => (e: unknown) => {
      if ((e as { status?: number } | null)?.status === 401) authHit = true;
      degraded.push(name);
      return null;
    };
    const [status, instances, lan, frp, router, providers, ports] = await Promise.all([
      supervisorApi.status({ signal: cycle?.signal }).catch(onReadError("状态")),
      supervisorApi.instances({ signal: cycle?.signal }).catch(onReadError("实例")),
      supervisorApi.lanAccess({ signal: cycle?.signal }).catch(onReadError("局域网")),
      supervisorApi.frp({ signal: cycle?.signal }).catch(onReadError("内网穿透")),
      supervisorApi.routerStatus({ signal: cycle?.signal }).catch(onReadError("路由")),
      supervisorApi.providers({ signal: cycle?.signal }).catch(onReadError("供应商")),
      supervisorApi.ports({ signal: cycle?.signal }).catch(onReadError("端口")),
    ]);
    const online = !!status;
    failStreak = online ? 0 : failStreak + 1;

    setPartial({ status, instances, lan, frp, router, providers, ports, online, degraded, authFailed: !online && authHit });
  } catch {
    failStreak += 1;
    setPartial({ online: false });
  } finally {
    busy = false;
    if (refreshPending) { refreshPending = false; void syncAll(); }
  }
}

async function refreshEvents() {
  if (eventsBusy) { refreshPending = true; return; }
  eventsBusy = true;
  try {
    const r = await supervisorApi.events(snap.eventsSeq, 60, { signal: cycle?.signal });
    if (r.events && r.events.length) {
      const seen = new Set<number>();
      const seenKey = new Set<string>();
      const merged: EventsPage["events"] = [];
      for (const e of [...r.events].reverse().concat(snap.events)) {
        if (e.seq === undefined) {
          // 无 seq 的事件不能靠 seq 去重：同一事件每拍重发会把 60 条列表刷满，
          // 只认第一份（后端已按 seq 升序，重发的最旧那条已在列表里）。
          const key = e.type + "@" + e.ts;
          if (seenKey.has(key)) continue;
          seenKey.add(key);
          merged.push(e);
          continue;
        }
        if (seen.has(e.seq)) continue;
        seen.add(e.seq);
        merged.push(e);
      }
      setPartial({
        events: merged.slice(0, 60),
        eventsSeq: Math.max(snap.eventsSeq, safeSeq(r.seq, snap.eventsSeq)),
      });
    }
  } catch { void 0; }
  finally {
    eventsBusy = false;
    if (refreshPending) { refreshPending = false; void syncAll(); void refreshEvents(); }
  }
}

export const supervisorStore = {
  get snapshot() { return snap; },
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  start() {
    if (started) return;
    started = true;
    cycle = new AbortController();
    void heartbeat();
  },
  stop() {
    if (timer) clearTimeout(timer);
    timer = null; started = false;
    // 先 abort 在途请求再换 epoch：未完成的 syncAll/refreshEvents 不会写回状态，
    // 也不会被清掉 busy 标记导致下次 start 与本次并发。
    cycle?.abort();
    cycle = null;
    epoch += 1; failStreak = 0; refreshPending = false;
  },
  refresh() {
    void refreshEvents();
    void syncAll();
  },
};
