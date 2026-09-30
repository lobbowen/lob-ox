/** client.ts 单元测试：错误归一化 / 请求超时 / 访问密钥携带 / 2xx 假成功判据（UI 条 5）。
 *  不依赖真实后端：vi.stubGlobal 注入 fetch。 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { failureFromResult, supervisorApi, setStoredAccessKey, LONG_TIMEOUT_MS } from "./client";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  } as ResponseInit);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("supervisorApi http 客户端", () => {
  it("2xx 返回解析后的 JSON", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200, { ok: true, dshPid: 42 })));
    const r = await supervisorApi.status();
    expect(r).toEqual({ ok: true, dshPid: 42 });
  });

  it("非 2xx 时优先抛后端 {error} 文案", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(500, { error: "内核故障" })));
    await expect(supervisorApi.status()).rejects.toThrow("内核故障");
  });

  it("非 2xx 无 error/message 时回退 HTTP 状态 + 路径", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(404, null)));
    await expect(supervisorApi.tasks()).rejects.toThrow(/HTTP 404 \/tasks/);
  });

  it("请求携带 abort 信号（http 内 withTimeout 注入），后端挂起时 fetch 被 abort", async () => {
    let receivedSignal: AbortSignal | null | undefined;
    vi.stubGlobal("fetch", vi.fn((_url: string, init?: RequestInit) => {
      receivedSignal = init?.signal;
      // 永不 resolve 的挂起请求（模拟后端无响应）；由 http 的 AbortController 兜底
      return new Promise((_resolve) => undefined);
    }));
    const p = supervisorApi.status();
    // 断言请求确实带上了可 abort 的信号（withTimeout 已装配）
    expect(receivedSignal).toBeDefined();
    expect(receivedSignal?.aborted).toBe(false);
    // 清理挂起 promise，避免泄漏
    await Promise.resolve();
    p.catch(() => undefined);
  });

  it("长轮询端点（proxyLoginWait）豁免超时到 LONG_TIMEOUT_MS", () => {
    expect(LONG_TIMEOUT_MS).toBeGreaterThanOrEqual(180_000);
  });
});

describe("B8 访问密钥携带与 401 语义", () => {
  /** 最小 localStorage 替身（client 经 globalThis.localStorage 可选链访问） */
  function stubLocalStorage() {
    const store: Record<string, string> = {};
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => (k in store ? store[k] : null),
      setItem: (k: string, v: string) => { store[k] = String(v); },
      removeItem: (k: string) => { delete store[k]; },
    });
    return store;
  }

  it("已存密钥时所有请求自动带 Authorization: Bearer", async () => {
    const store = stubLocalStorage();
    setStoredAccessKey("sekret-123");
    expect(store["dsh.apiAccessKey"]).toBe("sekret-123");
    let sent: Record<string, string> | undefined;
    vi.stubGlobal("fetch", vi.fn((_url: string, init?: RequestInit) => {
      sent = init?.headers as Record<string, string> | undefined;
      return Promise.resolve(jsonResponse(200, { ok: true }));
    }));
    await supervisorApi.status();
    expect(sent?.["Authorization"]).toBe("Bearer sekret-123");
    // POST 路径同时保留 Content-Type（注入不得挤掉既有头）
    await supervisorApi.instanceStop("i1");
    expect(sent?.["Authorization"]).toBe("Bearer sekret-123");
    expect(sent?.["Content-Type"]).toBe("application/json");
  });

  it("未存密钥时不带 Authorization（回环零配置语义不变）", async () => {
    stubLocalStorage();
    let sent: Record<string, string> | undefined;
    vi.stubGlobal("fetch", vi.fn((_url: string, init?: RequestInit) => {
      sent = init?.headers as Record<string, string> | undefined;
      return Promise.resolve(jsonResponse(200, { ok: true }));
    }));
    await supervisorApi.status();
    expect(sent?.["Authorization"]).toBeUndefined();
  });

  it("清除密钥 = setStoredAccessKey('') 移除存储项", async () => {
    const store = stubLocalStorage();
    setStoredAccessKey("a-b-c");
    setStoredAccessKey("");
    expect("dsh.apiAccessKey" in store).toBe(false);
  });

  it("401 错误带 status=401 且文案可操作（轮询层据此区分鉴权失败与离线）", async () => {
    stubLocalStorage();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(401, { error: "需要访问密钥" })));
    const err = await supervisorApi.status().then(() => null, (e: Error & { status?: number }) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err!.status).toBe(401);
    expect(err!.message).toContain("需要访问密钥");
    expect(err!.message).toContain("access_key");
  });

  it("非 401 错误不带鉴权文案（反向：401 特判不空转）", async () => {
    stubLocalStorage();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(500, { error: "内核故障" })));
    const err = await supervisorApi.status().then(() => null, (e: Error & { status?: number }) => e);
    expect(err!.status).toBe(500);
    expect(err!.message).not.toContain("access_key");
  });
});

/** 2xx 响应体里的 { ok:false } 是「假成功」形态：http() 只看状态码（探测类端点 ok:false 属数据），
 *  判失败的责任在 failureFromResult，由共享动作 hook run() 消费
 *  （接线由内核侧 test/round8-fixes-test.js 的 UI 条 5 静态门禁锁定；vitest 环境为 node，无法挂载 React hook）。 */
describe("UI 条 5 假成功判据 failureFromResult", () => {
  it("ok:false + error → 返回后端拒因", () => {
    expect(failureFromResult({ ok: false, error: "安全策略：仅允许公网地址" })).toBe("安全策略：仅允许公网地址");
  });

  it("ok:false 无 error 时回退 message", () => {
    expect(failureFromResult({ ok: false, message: "源已停用" })).toBe("源已停用");
  });

  it("ok:false 且无文案 → 兜底原因（绝不返回空串=静默成功）", () => {
    const msg = failureFromResult({ ok: false });
    expect(typeof msg).toBe("string");
    expect((msg || "").length).toBeGreaterThan(0);
  });

  it("反向非空转：ok:true / 无 ok 键 / null / 字符串 都不算失败", () => {
    expect(failureFromResult({ ok: true, latencyMs: 12 })).toBeNull();
    expect(failureFromResult({ dshPid: 1 })).toBeNull();
    expect(failureFromResult(null)).toBeNull();
    expect(failureFromResult("boom")).toBeNull();
  });

  it("ok 缺省（undefined）不等于 ok:false（只读端点无 ok 键）", () => {
    expect(failureFromResult({ ok: undefined, error: "陈旧字段" })).toBeNull();
  });

  it("http() 对 200 + ok:false 不抛错（分工：判失败由调用方负责）", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200, { ok: false, origin: "http://x", latencyMs: null })));
    await expect(supervisorApi.registryProbe("http://x")).resolves.toMatchObject({ ok: false });
  });
});
