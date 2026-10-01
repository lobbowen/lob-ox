/** 面板 -> 桌面壳内核更新消息桥：Tauri IPC 只注入主帧，面板在 iframe 内，故经 postMessage 请壳代执行。 */

/** 协议版本：语义变更必须递增，须与壳 src/bridge.rs 常量一致。 */
export const BRIDGE_PROTOCOL_VERSION = 1;

const REQUEST = "dsh:kernel-update-request";
const RESULT = "dsh:kernel-update-result";
const PROGRESS = "dsh:kernel-update-progress";

export type KernelUpdateResult = {
  ok: boolean;
  stage?: string | null;
  version?: string | null;
  restartUncertain?: boolean;
  error?: string | null;
};

/** 进度帧可多次且非终结。 */
export type KernelUpdateProgress = {
  stage?: string | null;
  /** 壳侧 domain/install.rs 成形的文字。 */
  status?: string | null;
  /** 0..1 或 null；null 不得当成 0 用。 */
  progress?: number | null;
};

/** 壳未在首帧下发 maxWaitMs 时的兜底上界；必须大于壳的总预算（17 分钟），
 *  否则面板先解禁、用户重试会造成两个进程并发写同一 npm 全局前缀。 */
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
      // 来源校验不能只靠 requestId（Math.random 是弱标识，可被伪造），
      //   硬判据是 ev.source === window.parent。
      if (ev.source !== window.parent) return;
      if (d.v !== BRIDGE_PROTOCOL_VERSION) return;
      if (d.type !== RESULT && d.type !== PROGRESS) return;
      if (d.requestId !== requestId) return;
      if (d.type === PROGRESS) {
        // 只有首帧带 maxWaitMs；其余帧只刷新文案。
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
      // 壳主帧 origin 是 Tauri 自定义协议，面板无从预知，故用 '*'；壳侧另校验来源。
      window.parent.postMessage({ v: BRIDGE_PROTOCOL_VERSION, type: REQUEST, requestId }, "*");
    } catch (e) {
      finish({ ok: false, error: String(e) });
    }
  });
}

export function hasShellHost(): boolean {
  try { return window.parent !== window; } catch { return false; }
}
