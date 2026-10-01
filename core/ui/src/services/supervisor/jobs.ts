export type JobState = "running" | "done" | "failed";

export interface PollJobOptions {
  intervalMs?: number;
  timeoutMs?: number;
  onTick?: (snap: unknown) => void;
  signal?: { aborted: boolean };
}

export interface PollJobResult<T> {
  state: JobState;
  snapshot: T | null;
  timedOut?: boolean;
  error?: string | null;
}

function readState(snap: unknown): JobState | null {
  if (!snap || typeof snap !== "object") return null;
  const s = (snap as { state?: unknown }).state;
  if (s === "done" || s === "failed" || s === "running") return s;
  return null;
}

/** @param fetchStatus 取状态快照，如 supervisorApi.pluginInstallStatus(jobId) */
export async function pollJob<T>(
  fetchStatus: () => Promise<T>,
  opts: PollJobOptions = {},
): Promise<PollJobResult<T>> {
  const intervalMs = Math.max(300, opts.intervalMs ?? 1200);
  const timeoutMs = Math.max(intervalMs, opts.timeoutMs ?? 10 * 60 * 1000);
  const started = Date.now();
  let last: T | null = null;
  for (;;) {
    if (opts.signal?.aborted) return { state: "running", snapshot: last, error: "已取消" };
    try {
      const snap = await fetchStatus();
      last = snap;
      if (opts.onTick) { try { opts.onTick(snap); } catch { /* 忽略回调异常 */ } }
      const st = readState(snap);
      if (st === "done") return { state: "done", snapshot: snap, error: null };
      if (st === "failed") {
        const err = (snap as { error?: string | null } | null)?.error ?? null;
        return { state: "failed", snapshot: snap, error: err };
      }
      // 后端返回 { error: 'job not found' }：视为终态失败（避免无限轮询）
      const rawErr = (snap as { error?: unknown } | null)?.error;
      if (rawErr && st === null) {
        return { state: "failed", snapshot: snap, error: String(rawErr) };
      }
    } catch {
      // 单次失败：继续重试
    }
    if (Date.now() - started >= timeoutMs) {
      return { state: "running", snapshot: last, timedOut: true };
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
