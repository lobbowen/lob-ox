/**
 * 任务轮询的唯一终态判定。
 * running 是唯一可继续的态；done/failed/timeout/canceled 都是终态，
 * 调用方必须四分支穷举，不得把「还在跑」当成「已完成」。
 */
export type JobState = "running" | "done" | "failed" | "timeout" | "canceled";

export interface PollJobOptions {
  intervalMs?: number;
  timeoutMs?: number;
  onTick?: (snap: unknown) => void;
  signal?: { aborted: boolean };
}

/** 网络不可达与后端明确报错是两件事，必须在结果里分开呈现。 */
const MAX_FETCH_ERRORS = 3;

export interface PollJobResult<T> {
  state: JobState;
  snapshot: T | null;
  error?: string | null;
}

function readState(snap: unknown): JobState | null {
  if (!snap || typeof snap !== "object") return null;
  const s = (snap as { state?: unknown }).state;
  if (s === "done" || s === "failed" || s === "running") return s;
  return null;
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export async function pollJob<T>(
  fetchStatus: () => Promise<T>,
  opts: PollJobOptions = {},
): Promise<PollJobResult<T>> {
  const intervalMs = Math.max(300, opts.intervalMs ?? 1200);
  const timeoutMs = Math.max(intervalMs, opts.timeoutMs ?? 10 * 60 * 1000);
  const started = Date.now();
  let last: T | null = null;
  let fetchErrors = 0;
  let lastFetchError: string | null = null;
  for (;;) {
    if (opts.signal?.aborted) return { state: "canceled", snapshot: last, error: "已取消" };
    try {
      const snap = await fetchStatus();
      fetchErrors = 0;
      lastFetchError = null;
      last = snap;
      if (opts.onTick) { try { opts.onTick(snap); } catch { void 0; } }
      const st = readState(snap);
      if (st === "done") return { state: "done", snapshot: snap, error: null };
      if (st === "failed") {
        const err = (snap as { error?: string | null } | null)?.error ?? null;
        return { state: "failed", snapshot: snap, error: err };
      }
      // 响应体带 error 而 state 未知：后端已明确报错，只是没有状态字段。
      const rawErr = (snap as { error?: unknown } | null)?.error;
      if (rawErr && st === null) {
        return { state: "failed", snapshot: snap, error: String(rawErr) };
      }
    } catch (e) {
      fetchErrors += 1;
      lastFetchError = errText(e);
      if (fetchErrors >= MAX_FETCH_ERRORS) {
        return {
          state: "failed",
          snapshot: last,
          error: "连不上管家服务（连续 " + fetchErrors + " 次请求失败：" + lastFetchError + "）",
        };
      }
    }
    if (Date.now() - started >= timeoutMs) {
      return { state: "timeout", snapshot: last, error: "等待超时（" + Math.round(timeoutMs / 1000) + "s 未完成）" };
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
