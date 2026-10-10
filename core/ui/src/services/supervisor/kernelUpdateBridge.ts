export const BRIDGE_PROTOCOL_VERSION = 2;

const REQUEST = "lobox:kernel-update-request";
const RESULT = "lobox:kernel-update-result";
const PROGRESS = "lobox:kernel-update-progress";

export type KernelUpdateResult = {
  ok: boolean;
  stage?: string | null;
  version?: string | null;
  restartUncertain?: boolean;
  error?: string | null;
};

export type KernelUpdateProgress = {
  stage?: string | null;
  
  status?: string | null;
  
  progress?: number | null;
};

const FALLBACK_MAX_WAIT_MS = 20 * 60 * 1000;

export function requestKernelUpdate(onProgress?: (p: KernelUpdateProgress) => void): Promise<KernelUpdateResult> {
  return new Promise((resolve) => {
    if (!hasShellHost()) {
      resolve({ ok: false, error: "内核更新由桌面壳执行：请在桌面壳面板中操作。" });
      return;
    }
    const requestId = "kupd-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
    const startedAt = Date.now();
    let done = false;
    let lastStatus: string | null = null;
    let timer = setTimeout(finishTimeout, FALLBACK_MAX_WAIT_MS);
    function finishTimeout() {
      finish(lastStatus
        ? { ok: false, error: "桌面壳无响应（更新请求超时；最后一次进度：" + lastStatus + "）" }
        : { ok: false, error: "桌面壳无响应（更新请求超时）" });
    }
    const arm = (ms: number) => {
      clearTimeout(timer);
      timer = setTimeout(finishTimeout, Math.max(0, ms));
    };
    const finish = (r: KernelUpdateResult) => {
      if (done) return;
      done = true;
      window.removeEventListener("message", onMessage);
      clearTimeout(timer);
      resolve(r);
    };
    const onMessage = (ev: MessageEvent) => {
      const d = ev.data as Record<string, unknown> | null;
      if (!d || typeof d !== "object") return;
      
      
      if (ev.source !== window.parent) return;
      if (d.v !== BRIDGE_PROTOCOL_VERSION) return;
      if (d.type !== RESULT && d.type !== PROGRESS) return;
      if (d.requestId !== requestId) return;
      if (d.type === PROGRESS) {
        
        const status = typeof d.status === "string" && d.status ? d.status : null;
        if (status) lastStatus = status;
        onProgress?.({
          stage: typeof d.stage === "string" ? d.stage : null,
          status,
          progress: typeof d.progress === "number" ? d.progress : null,
        });
        const maxWait = typeof d.maxWaitMs === "number" ? d.maxWaitMs : 0;
        if (maxWait > 0) arm(maxWait - (Date.now() - startedAt));
        return;
      }
      finish({
        ok: d.ok === true,
        stage: (d.stage as string) ?? null,
        version: (d.version as string) ?? null,
        restartUncertain: d.restartUncertain === true,
        error: (d.error as string) ?? null,
      });
    };
    window.addEventListener("message", onMessage);
    try {
      
      window.parent.postMessage({ v: BRIDGE_PROTOCOL_VERSION, type: REQUEST, requestId }, "*");
    } catch (e) {
      finish({ ok: false, error: String(e) });
    }
  });
}

export function hasShellHost(): boolean {
  try { return window.parent !== window; } catch { return false; }
}
