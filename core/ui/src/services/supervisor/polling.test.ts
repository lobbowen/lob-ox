import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { supervisorStore } from "./polling";

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

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
    installFetch(() => {
      call += 1;
      return eventsResponse(3, [1, 2, 3]);
    });
    supervisorStore.refresh();
    supervisorStore.refresh();
    await settle();
    const events = supervisorStore.snapshot.events;
    expect(events).toHaveLength(3);
    const seqs = events.map((e) => e.seq);
    expect(new Set(seqs).size).toBe(3);
  });

  it("非重叠增量正确拼接并按 seq 推进游标", async () => {
    installFetch((after) => {
      if (after >= 3) return eventsResponse(5, [4, 5]);
      return eventsResponse(3, [1, 2, 3]);
    });
    supervisorStore.refresh();
    await settle();
    expect(supervisorStore.snapshot.events.map((e) => e.seq)).toEqual([3, 2, 1]);
    supervisorStore.refresh();
    await settle();
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
    supervisorStore.refresh();
    supervisorStore.refresh();
    supervisorStore.refresh();
    await settle();
    expect(supervisorStore.snapshot.events).toHaveLength(3);
  });
});

describe("事件游标与心跳退避", () => {
  it("非法 seq 不得污染游标（NaN 会让后续 after=NaN 永久停摆）", async () => {
    const asked: Array<string | null> = [];
    vi.stubGlobal("fetch", vi.fn((url: string) => {
      const u = new URL(url, "http://localhost");
      if (u.pathname === "/events") {
        asked.push(u.searchParams.get("after"));
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
    expect(supervisorStore.snapshot.events.map((e) => e.seq)).toEqual([4]);
  });

  it("连续失败按 2s→4s→8s 退避、封顶 30s，链路恢复即回 2s", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new TypeError("fetch failed"))));
    expect(supervisorStore._delayMsForTest()).toBe(2000);
    supervisorStore.refresh();
    await settle();
    expect(supervisorStore._delayMsForTest()).toBe(2000);
    supervisorStore.refresh();
    await settle();
    expect(supervisorStore._delayMsForTest()).toBe(4000);
    supervisorStore.refresh();
    await settle();
    expect(supervisorStore._delayMsForTest()).toBe(8000);
    for (let i = 0; i < 6; i++) {
      supervisorStore.refresh();
      await settle();
    }
    expect(supervisorStore._delayMsForTest()).toBe(30_000);
    installFetch(() => eventsResponse(0, []));
    supervisorStore.refresh();
    await settle();
    expect(supervisorStore._delayMsForTest()).toBe(2000);
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
      expect(statusCalls).toBeGreaterThanOrEqual(2);
      const frozen = statusCalls;
      supervisorStore.stop();
      await vi.advanceTimersByTimeAsync(20_000);
      expect(statusCalls).toBe(frozen);
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
      expect(calls).toBeGreaterThan(0);
      expect(calls).toBeLessThan(60);
    } finally {
      vi.useRealTimers();
    }
  });
});
