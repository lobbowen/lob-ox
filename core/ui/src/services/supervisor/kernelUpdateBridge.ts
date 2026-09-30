/** 面板 -> 桌面壳 内核更新消息桥（单写入者契约：内核安装/升级唯一写入者是桌面壳；面板在壳内容 iframe 内，
 *  Tauri IPC 只注入主帧，故经 postMessage 请壳代执行；协议版本与来源校验在壳侧 bridge.rs，两侧常量由门禁锁定，SW-1/SW-8）。
 *  进度帧可多次且非终结；等待上界以首帧 maxWaitMs 为唯一时间事实源（壳侧契约 K6/K7，面板不自估）。 */

/** 协议版本：任何语义变更必须递增；须与壳 src/bridge.rs 的常量一致。 */
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

/** 壳中继过来的安装进度（非终结，可多次：开工行 / 换源行 / npm 心跳行）。 */
export type KernelUpdateProgress = {
  stage?: string | null;
  /** 壳侧 domain/install.rs 成形的文字（含真实心跳：已用时 / 输出行数 / 末行）。 */
  status?: string | null;
  /** 0..1 或 null；null = 这一步没有可测分母，不得当成 0 用。 */
  progress?: number | null;
};

/** 等待上界兜底值：壳未在首帧给出 maxWaitMs 时（旧版壳）用这个，新壳经契约下发真实值。
 *  必须明显大于壳的总预算（17 分钟）：否则面板按钮先于壳完成而解禁、用户重试，
 *  会变成两个进程并发写同一个 npm 全局前缀。 */
const FALLBACK_MAX_WAIT_MS = 20 * 60 * 1000;

/** 请求桌面壳更新内核并等待终结结果；onProgress 每收到一帧进度回调一次。 */
export function requestKernelUpdate(onProgress?: (p: KernelUpdateProgress) => void): Promise<KernelUpdateResult> {
  return new Promise((resolve) => {
    if (!hasShellHost()) {
      resolve({ ok: false, error: "内核更新由桌面壳执行：请在桌面壳面板中操作。" });
      return;
    }
    const requestId = "kupd-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
    const startedAt = Date.now();
    let done = false;
    // 超时文案要带上壳最后一次进度，裸的「无响应」会丢失定位线索。
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
      // 来源校验不能只做在壳侧：requestId 的随机片段是弱标识（Math.random），
      //   任何能向本 iframe 派发 message 的上下文都能伪造「更新成功」。
      //   故以 ev.source === window.parent 作硬判据（Tauri 自定义协议 origin 无法预知，白名单不可用）。
      if (ev.source !== window.parent) return;
      if (d.v !== BRIDGE_PROTOCOL_VERSION) return;
      if (d.type !== RESULT && d.type !== PROGRESS) return;
      if (d.requestId !== requestId) return;
      if (d.type === PROGRESS) {
        // 进度帧不终结请求，但做两件事：把文字交给 UI，以及用壳下发的真实预算重设等待上界
        //   （只有首帧带 maxWaitMs；其余帧只刷新文案，顺带证明壳还活着）。
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
      // 壳主帧 origin 是 Tauri 自定义协议（tauri://localhost 等），面板无从预知，故请求用 '*'；
      // 壳侧以 ev.source === 内容 iframe + 回环 origin 校验来源（K2）。
      window.parent.postMessage({ v: BRIDGE_PROTOCOL_VERSION, type: REQUEST, requestId }, "*");
    } catch (e) {
      finish({ ok: false, error: String(e) });
    }
  });
}

/** 是否运行在桌面壳宿主内（无宿主 = 用独立浏览器打开面板，不能更新内核）。 */
export function hasShellHost(): boolean {
  try { return window.parent !== window; } catch { return false; }
}
