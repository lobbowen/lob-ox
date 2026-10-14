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
      if (opts.onTick) { try { opts.onTick(snap); } catch { void 0; } }
      const st = readState(snap);
      if (st === "done") return { state: "done", snapshot: snap, error: null };
      if (st === "failed") {
        const err = (snap as { error?: string | null } | null)?.error ?? null;
        return { state: "failed", snapshot: snap, error: err };
      }
      
      const rawErr = (snap as { error?: unknown } | null)?.error;
      if (rawErr && st === null) {
        return { state: "failed", snapshot: snap, error: String(rawErr) };
      }
    } catch { void 0; }
    if (Date.now() - started >= timeoutMs) {
      return { state: "running", snapshot: last, timedOut: true };
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
