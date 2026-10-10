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
  
  authFailed: boolean;
}

function empty(): SupervisorSnapshot {
  return {
    status: null, instances: null, lan: null, frp: null,
    router: null, providers: null, ports: null,
    events: [], eventsSeq: 0, online: false, authFailed: false,
  };
}

type Listener = (snap: SupervisorSnapshot) => void;
const listeners = new Set<Listener>();
let snap = empty();
let started = false;
let timer: ReturnType<typeof setTimeout> | null = null;
let busy = false;

let eventsBusy = false;

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
function setPartial(p: Partial<SupervisorSnapshot>) { snap = { ...snap, ...p }; emit(); }

let epoch = 0;

async function heartbeat() {
  const mine = epoch;
  await Promise.all([refreshEvents(), syncAll()]);
  if (mine !== epoch || !started) return;
  timer = setTimeout(() => { void heartbeat(); }, tickDelayMs());
}

async function syncAll() {
  if (busy) return;
  busy = true;
  try {
    let authHit = false;
    const onReadError = (e: unknown) => {
      if ((e as { status?: number } | null)?.status === 401) authHit = true;
      return null;
    };
    const [status, instances, lan, frp, router, providers, ports] = await Promise.all([
      supervisorApi.status().catch(onReadError),
      supervisorApi.instances().catch(onReadError),
      supervisorApi.lanAccess().catch(onReadError),
      supervisorApi.frp().catch(onReadError),
      supervisorApi.routerStatus().catch(onReadError),
      supervisorApi.providers().catch(onReadError),
      supervisorApi.ports().catch(onReadError),
    ]);
    const online = !!status;
    failStreak = online ? 0 : failStreak + 1;
    
    setPartial({ status, instances, lan, frp, router, providers, ports, online, authFailed: !online && authHit });
  } catch {
    failStreak += 1;
    setPartial({ online: false });
  } finally {
    busy = false;
  }
}

async function refreshEvents() {
  if (eventsBusy) return;
  eventsBusy = true;
  try {
    const r = await supervisorApi.events(snap.eventsSeq, 60);
    if (r.events && r.events.length) {
      
      const seen = new Set<number>();
      const merged: EventsPage["events"] = [];
      for (const e of [...r.events].reverse().concat(snap.events)) {
        if (e.seq === undefined) { merged.push(e); continue; }
        if (seen.has(e.seq)) continue;
        seen.add(e.seq);
        merged.push(e);
      }
      setPartial({
        events: merged.slice(0, 60),
        eventsSeq: Math.max(snap.eventsSeq, safeSeq(r.seq, snap.eventsSeq)),
      });
    }
  } catch {  }
  finally { eventsBusy = false; }
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
    void heartbeat();
  },
  stop() {
    if (timer) clearTimeout(timer);
    timer = null; started = false;
    epoch += 1; busy = false; eventsBusy = false; failStreak = 0;
  },
  refresh() {
    void refreshEvents();
    void syncAll();
  },
  _delayMsForTest() { return tickDelayMs(); },
  _resetForTest() {
    listeners.clear();
    snap = empty();
    busy = false; eventsBusy = false; started = false; failStreak = 0;
    epoch += 1;
    if (timer) clearTimeout(timer); timer = null;
  },
};
