/** supervisor 运行态轮询中心（单源快照 -> 视图只读）：start() 每轮并行拉运行态 + 增量事件（after=seq），写完自排下一轮，
 *  健康 2s，连续失败 2s->4s->8s 退避封顶 30s（UI 条 6）；写操作后可 refresh() 立即同步一次；纯 JS set 订阅，页面用 useSyncExternalStore 消费。 */
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
  /** 端口注册表快照（已收敛进统一心跳，无独立轮询） */
  ports: PortsResponse | null;
  events: EventsPage["events"];
  eventsSeq: number;
  online: boolean;
  /** 全部读取都因 401（访问密钥缺失/过期）失败：是「鉴权被拒」而非「管家离线」，须呈现为可操作错误。 */
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
/** 事件增量拉取的 in-flight 守卫：refreshEvents 与 syncAll 相互独立，防慢网下并发交叠致同批事件双插。 */
let eventsBusy = false;

/** 心跳基准/上限间隔（UI 条 6 退避） */
const BASE_TICK_MS = 2000;
const MAX_TICK_MS = 30_000;
/** 连续 syncAll 失败次数：成功后清零，是退避的唯一依据（UI 条 6）。 */
let failStreak = 0;

/** 下一轮心跳间隔：第 2 次连续失败起翻倍，封顶 MAX_TICK_MS。 */
function tickDelayMs(): number {
  if (failStreak <= 1) return BASE_TICK_MS;
  return Math.min(MAX_TICK_MS, BASE_TICK_MS * 2 ** (failStreak - 1));
}

/** 事件游标归一化（UI 条 6）：后端异常时 r.seq 可能为 null/字符串/NaN。NaN 写进 eventsSeq 会永久污染
 *  （Math.max(NaN,x) 恒为 NaN，下轮 after=NaN 再也拉不到事件），故非法值退回当前游标，不回退 0 造成重放。 */
function safeSeq(v: unknown, fallback: number): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function emit() { for (const l of listeners) l(snap); }
function setPartial(p: Partial<SupervisorSnapshot>) { snap = { ...snap, ...p }; emit(); }

/** 心跳链世代号：stop() 后在途的那一轮不得再排下一轮（否则 start() 会同时跑两条链）。 */
let epoch = 0;

/** 统一心跳：一轮跑完再按退避间隔自排下一轮（UI 条 6），以便按失败次数调整间隔并避免慢网下轮次堆叠。 */
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
    // 401 单独记账——真离线（连接失败/超时）与鉴权被拒是两种病，不能都渲染成「离线」。
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
    // 退避只看「运行态是否读到」——status 读到即认为链路健康，个别域读失败
    // 由快照的 null 字段如实呈现，不该拖慢整条心跳。
    failStreak = online ? 0 : failStreak + 1;
    // 心跳不附带 /tasks：snap.tasks 无消费者（TasksPage 自管本地 state + 手动刷新），避免每拍白拉低频任务列表。
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
      // 后端增量升序 -> 反转后新批次在前（数组头 = 最新）。
      // 按 seq 去重兜底：即使 in-flight 曾交叠/后端游标回退，也不让同 seq 双插。
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
  } catch { /* 静默 */ }
  finally { eventsBusy = false; }
}

export const supervisorStore = {
  get snapshot() { return snap; },
  /** 订阅快照变更；返回取消函数 */
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  /** 启动统一心跳（事件高频 + 运行态）；首轮立即同步，之后按退避间隔自排（UI 条 6） */
  start() {
    if (started) return;
    started = true;
    void heartbeat();
  },
  stop() {
    if (timer) clearTimeout(timer);
    timer = null; started = false;
    // 卸载后彻底清场：事件保留（宿主重挂载时可续看），但复位运行态守卫标记
    epoch += 1; busy = false; eventsBusy = false; failStreak = 0;
  },
  /** 任意写操作后立即同步一次（操作 -> 同步 -> 渲染）；不参与退避，始终即时 */
  refresh() {
    void refreshEvents();
    void syncAll();
  },
  /** 测试专用：当前应等待的心跳间隔（退避曲线可断言，不依赖真实计时器） */
  _delayMsForTest() { return tickDelayMs(); },
  /** 测试专用：清空快照与订阅（仅在 vitest 中调用） */
  _resetForTest() {
    listeners.clear();
    snap = empty();
    busy = false; eventsBusy = false; started = false; failStreak = 0;
    epoch += 1;
    if (timer) clearTimeout(timer); timer = null;
  },
};
