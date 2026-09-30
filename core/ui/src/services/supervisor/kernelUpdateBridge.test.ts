// 面板 -> 壳 内核更新桥的行为测试。三条判据的失败模式都是静默的（伪造成功、进度丢失、超时误报后重试即并发写同一个 npm 全局包）；
// 形态门禁（test/kernel-update-single-writer-test.js SW-9）只证明代码里有字样、证不了真生效，故两边都要锁。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BRIDGE_PROTOCOL_VERSION,
  hasShellHost,
  requestKernelUpdate,
  type KernelUpdateProgress,
  type KernelUpdateResult,
} from "./kernelUpdateBridge";

// 线格式在测试里重写字面量（不复用模块常量）：桥两侧各自持常量，跨仓一致性由门禁钉，
//   测试若复用同一常量就等于「用实现验证实现」，改错常量时两边一起错。
const REQUEST = "dsh:kernel-update-request";
const RESULT = "dsh:kernel-update-result";
const PROGRESS = "dsh:kernel-update-progress";

type Handler = (ev: MessageEvent) => void;

function installWindow(withShellHost: boolean) {
  const handlers = new Set<Handler>();
  const toParent = vi.fn();
  const win: Record<string, unknown> = {
    addEventListener: (_t: string, h: Handler) => { handlers.add(h); },
    removeEventListener: (_t: string, h: Handler) => { handlers.delete(h); },
    postMessage: vi.fn(),
  };
  win.parent = withShellHost ? { postMessage: toParent } : win; // 顶层窗口：parent === window
  vi.stubGlobal("window", win as unknown as Window & typeof globalThis);
  const dispatch = (data: unknown, source: unknown = win.parent) => {
    for (const h of Array.from(handlers)) h({ data, source } as MessageEvent);
  };
  return { toParent, dispatch, listeners: () => handlers.size };
}

/** 取面板发出的 requestId（每请求随机，必须由实现给出而非测试拼一个）。 */
function requestIdOf(toParent: { mock: { calls: unknown[][] } }): string {
  const call = toParent.mock.calls[0] as [unknown, string];
  return (call[0] as { requestId: string }).requestId;
}

describe("kernelUpdateBridge：无宿主即拒绝", () => {
  let h: ReturnType<typeof installWindow>;
  beforeEach(() => { h = installWindow(false); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("hasShellHost 在顶层窗口为 false", () => {
    expect(hasShellHost()).toBe(false);
  });

  it("无壳宿主时直接失败，且不发任何出站消息", async () => {
    const r = await requestKernelUpdate();
    expect(r.ok).toBe(false);
    expect(r.error || "").toContain("桌面壳");
    expect(h.toParent).not.toHaveBeenCalled();
  });
});

describe("kernelUpdateBridge：出站请求", () => {
  let h: ReturnType<typeof installWindow>;
  beforeEach(() => { h = installWindow(true); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("带协议版本与请求类型", async () => {
    void requestKernelUpdate();
    const [msg, target] = h.toParent.mock.calls[0] as [Record<string, unknown>, string];
    expect(msg.v).toBe(BRIDGE_PROTOCOL_VERSION);
    expect(msg.type).toBe(REQUEST);
    expect(typeof msg.requestId).toBe("string");
    // 出站允许 '*'：壳主帧是 Tauri 自定义协议 origin，面板无从预知（入向另有硬校验）。
    expect(target).toBe("*");
  });
});

describe("kernelUpdateBridge：入站校验、进度与超时", () => {
  let h: ReturnType<typeof installWindow>;
  let settled: KernelUpdateResult | null;
  let progress: KernelUpdateProgress[];

  const start = () => {
    void requestKernelUpdate((p) => { progress.push(p); }).then((r) => { settled = r; });
    return requestIdOf(h.toParent);
  };
  const resultFrame = (rid: string) => ({ v: BRIDGE_PROTOCOL_VERSION, type: RESULT, requestId: rid, ok: true, version: "9.9.9" });
  const flush = async () => { await vi.advanceTimersByTimeAsync(0); };

  beforeEach(() => {
    vi.useFakeTimers();
    h = installWindow(true);
    settled = null;
    progress = [];
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("非父帧来源的“成功”被忽略（门禁 SW-8 的行为面）", async () => {
    const rid = start();
    h.dispatch(resultFrame(rid), { notTheParent: true });
    await flush();
    expect(settled).toBe(null);
    h.dispatch(resultFrame(rid));
    await flush();
    expect(settled?.ok).toBe(true);
    expect(settled?.version).toBe("9.9.9");
  });

  it("requestId 不匹配的终结帧被忽略", async () => {
    start();
    h.dispatch(resultFrame("kupd-other"));
    await flush();
    expect(settled).toBe(null);
  });

  it("协议版本不符的帧被忽略", async () => {
    const rid = start();
    h.dispatch({ ...resultFrame(rid), v: BRIDGE_PROTOCOL_VERSION + 1 });
    await flush();
    expect(settled).toBe(null);
  });

  it("进度帧回调 UI 且不终结请求；null 进度不被当成 0", async () => {
    const rid = start();
    h.dispatch({ v: BRIDGE_PROTOCOL_VERSION, type: PROGRESS, requestId: rid, stage: "install", status: "npm 安装中 · 已用 95s", progress: null });
    await flush();
    expect(progress.length).toBe(1);
    expect(progress[0].status).toBe("npm 安装中 · 已用 95s");
    expect(progress[0].progress).toBe(null);
    expect(settled).toBe(null);
    h.dispatch({ v: BRIDGE_PROTOCOL_VERSION, type: PROGRESS, requestId: rid, stage: "install", status: "已取回 3.0 / 8.0 MB", progress: 0.375 });
    await flush();
    expect(progress[1].progress).toBe(0.375);
    expect(settled).toBe(null);
  });

  it("首帧 maxWaitMs 决定等待上界，超时文案带最后一次进度", async () => {
    const rid = start();
    h.dispatch({ v: BRIDGE_PROTOCOL_VERSION, type: PROGRESS, requestId: rid, stage: "start", maxWaitMs: 7000 });
    await vi.advanceTimersByTimeAsync(6900);
    expect(settled).toBe(null);
    h.dispatch({ v: BRIDGE_PROTOCOL_VERSION, type: PROGRESS, requestId: rid, stage: "install", status: "第 2/4 个源", progress: null });
    await vi.advanceTimersByTimeAsync(200);
    expect(settled?.ok).toBe(false);
    expect(settled?.error || "").toContain("第 2/4 个源");
  });

  it("旧壳不下发 maxWaitMs 时，兜底上界必须大于后端 17 分钟预算（写死 6 分钟即回归）", async () => {
    start();
    await vi.advanceTimersByTimeAsync(6 * 60 * 1000 + 1000);
    expect(settled).toBe(null);
    await vi.advanceTimersByTimeAsync(17 * 60 * 1000);
    expect(settled?.ok).toBe(false);
    expect(settled?.error || "").toContain("超时");
  });

  it("终结后摘掉监听器（后续帧不再打扰）", async () => {
    const rid = start();
    expect(h.listeners()).toBe(1);
    h.dispatch(resultFrame(rid));
    await flush();
    expect(h.listeners()).toBe(0);
  });
});
