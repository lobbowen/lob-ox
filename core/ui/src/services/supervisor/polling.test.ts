/** polling.ts 单元测试：事件增量去重 + in-flight 守卫 + 游标防污染/失败退避（UI 条 6）。
 *  vi.stubGlobal 注入 fetch 验证 refreshEvents 合并去重与并发守卫；退避/心跳自排用 vi.useFakeTimers()（断言取宽窗口，避免与微任务节奏打架）。 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { supervisorStore } from "./polling";

/** 等待事件循环微任务链（refresh 内部 async 无句柄可 await，需拍两拍） */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** 构造 /events 返回，含升序 seq 的事件批次 */
function eventsResponse(seq: number, seqList: number[]): Response {
  const events = seqList.map((s) => ({ seq: s, type: "running", ts: new Date().toISOString() }));
  return new Response(JSON.stringify({ seq, events }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
function emptyResponse(body: object): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

const baseEndpoints: Record<string, object> = {
  "/status": { phase: "RUNNING", dshPid: 1 },
  "/instances": { instances: [] },
  "/lan-access": { items: [], addresses: [] },
  "/remote/frp": { installed: false, running: false, settings: {} },
  "/router/status": { running: false, usage: {} },
  "/router/providers": { presets: [], providers: [], proxyApps: [] },
  "/ports": { records: [] },
  "/lifecycle/status": { modules: [] },
};

function installFetch(eventsHandler: (seq: number) => Response) {
  vi.stubGlobal("fetch", vi.fn((url: string) => {
    const path = new URL(url, "http://localhost").pathname;
    if (path === "/events") {
      const after = Number(new URL(url, "http://localhost").searchParams.get("after") || 0);
      return Promise.resolve(eventsHandler(after));
    }
    return Promise.resolve(emptyResponse(baseEndpoints[path] ?? { error: "not-found" }));
  }));
}

beforeEach(() => {
  supervisorStore._resetForTest();
});
afterEach(() => {
  vi.unstubAllGlobals();
  supervisorStore.stop();
  supervisorStore._resetForTest();
});

describe("supervisorStore 事件合并", () => {
  it("按 seq 去重：两批含重叠 seq 时最终事件无重复", async () => {
    let call = 0;
    // 第一批 [(1,2,3)]，第二批仍返回 [(1,2,3)]（模拟后端游标回退/并发内联）
    installFetch(() => {
      call += 1;
      return eventsResponse(3, [1, 2, 3]);
    });
    // 手动触发 refreshEvents 两次（refresh 内部含 events 刷新）
    supervisorStore.refresh();
    supervisorStore.refresh();
    await settle();
    const events = supervisorStore.snapshot.events;
    // 批次反转保证最新在前；两批同 seq -> 去重后应为 3 条且 seq 不重复
    expect(events).toHaveLength(3);
    const seqs = events.map((e) => e.seq);
    expect(new Set(seqs).size).toBe(3);
  });

  it("非重叠增量正确拼接并按 seq 推进游标", async () => {
    // 按游标返回确定批次：after=0 -> [1,2,3](seq3)；after=3 -> [4,5](seq5)
    installFetch((after) => {
      if (after >= 3) return eventsResponse(5, [4, 5]);
      return eventsResponse(3, [1, 2, 3]);
    });
    supervisorStore.refresh();
    await settle();
    // 首次拉取完成，eventsSeq 推进到 3
    expect(supervisorStore.snapshot.events.map((e) => e.seq)).toEqual([3, 2, 1]);
    supervisorStore.refresh();
    await settle();
    // 第二次按 after=3 增量拉 [4,5]，合并去重后头插 -> [5,4,3,2,1]
    const events = supervisorStore.snapshot.events;
    expect(events.map((e) => e.seq)).toEqual([5, 4, 3, 2, 1]);
    expect(supervisorStore.snapshot.eventsSeq).toBe(5);
  });

  it("in-flight 守卫：并发 refresh 不因竞态双插", async () => {
    let inFlight = 0;
    let maxConcurrent = 0;
    installFetch((_seq) => {
      inFlight += 1;
      maxConcurrent = Math.max(maxConcurrent, inFlight);
      return eventsResponse(3, [1, 2, 3]);
    });
    // 同时触发多次 refresh（syncAll + refreshEvents 各自独立，events 应有自己的守卫）
    supervisorStore.refresh();
    supervisorStore.refresh();
    supervisorStore.refresh();
    await settle();
    expect(supervisorStore.snapshot.events).toHaveLength(3);
  });
});

/** 游标防污染 + 心跳失败退避：退避曲线用 refresh() 驱动（确定性、不依赖计时器），心跳是否真的自排/停得下来用 fake timers 计数。
 *  两条 fake-timer 用例互为对照 —— 健康用例证明链条确实推进，失败用例才不至于「因为压根没跑」而假通过。 */
describe("UI 条 6 事件游标与心跳退避", () => {
  it("非法 seq 不得污染游标（NaN 会让后续 after=NaN 永久停摆）", async () => {
    const asked: Array<string | null> = [];
    vi.stubGlobal("fetch", vi.fn((url: string) => {
      const u = new URL(url, "http://localhost");
      if (u.pathname === "/events") {
        asked.push(u.searchParams.get("after"));
        // 带事件的批次才会写游标；但顶层 seq 是垃圾值（后端异常/字段漂移）
        return Promise.resolve(new Response(
          JSON.stringify({ seq: "not-a-number", events: [{ seq: 4, type: "running" }] }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ));
      }
      return Promise.resolve(emptyResponse(baseEndpoints[u.pathname] ?? {}));
    }));
    supervisorStore.refresh();
    await settle();
    expect(Number.isFinite(supervisorStore.snapshot.eventsSeq)).toBe(true);
    expect(supervisorStore.snapshot.eventsSeq).toBe(0);
    supervisorStore.refresh();
    await settle();
    expect(asked).toHaveLength(2);
    expect(asked[1]).not.toContain("NaN");
    expect(Number.isFinite(Number(asked[1]))).toBe(true);
    // 事件本身照常并入（归一化只挡游标，不丢数据）
    expect(supervisorStore.snapshot.events.map((e) => e.seq)).toEqual([4]);
  });

  it("连续失败按 2s→4s→8s 退避、封顶 30s，链路恢复即回 2s", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new TypeError("fetch failed"))));
    expect(supervisorStore._delayMsForTest()).toBe(2000);
    supervisorStore.refresh();
    await settle();
    expect(supervisorStore._delayMsForTest()).toBe(2000);   // 连败 1 不罚
    supervisorStore.refresh();
    await settle();
    expect(supervisorStore._delayMsForTest()).toBe(4000);   // 连败 2
    supervisorStore.refresh();
    await settle();
    expect(supervisorStore._delayMsForTest()).toBe(8000);   // 连败 3
    for (let i = 0; i < 6; i++) {
      supervisorStore.refresh();
      await settle();
    }
    expect(supervisorStore._delayMsForTest()).toBe(30_000); // 封顶，不再是指数发散
    installFetch(() => eventsResponse(0, []));              // 恢复：/status 回到 200
    supervisorStore.refresh();
    await settle();
    expect(supervisorStore._delayMsForTest()).toBe(2000);   // 反向非空转：成功确实清零
  });

  it("心跳自排：健康时约每 2s 一拍，stop() 后不再打点", async () => {
    vi.useFakeTimers();
    try {
      let statusCalls = 0;
      vi.stubGlobal("fetch", vi.fn((url: string) => {
        const p = new URL(url, "http://localhost").pathname;
        if (p === "/status") statusCalls += 1;
        return Promise.resolve(emptyResponse(baseEndpoints[p] ?? {}));
      }));
      supervisorStore.start();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(statusCalls).toBeGreaterThanOrEqual(2);   // 证明链条真的在自排
      const frozen = statusCalls;
      supervisorStore.stop();
      await vi.advanceTimersByTimeAsync(20_000);
      expect(statusCalls).toBe(frozen);                // 卸载即彻底停（无泄漏定时器）
    } finally {
      vi.useRealTimers();
    }
  });

  it("守卫离线时不再每 2s 打满请求（30s 窗口远低于无退避基线）", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      vi.stubGlobal("fetch", vi.fn(() => {
        calls += 1;
        return Promise.reject(new TypeError("fetch failed"));
      }));
      supervisorStore.start();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(calls).toBeGreaterThan(0);      // 反向：仍在重试，不是放弃
      expect(calls).toBeLessThan(60);        // 无退避基线 = 15 轮 x 8 请求 = 120
    } finally {
      vi.useRealTimers();
    }
  });
});
