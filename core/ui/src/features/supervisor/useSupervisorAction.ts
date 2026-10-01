import { useCallback, useState } from "react";
import { toast } from "sonner";
import { failureFromResult, supervisorStore } from "../../services/supervisor";

export type ActionBusy = string | null;

export type RunOptions = {
  success?: string;
  refresh?: boolean;
  onDone?: () => void;
};

export function useSupervisorAction() {
  const [busy, setBusy] = useState<ActionBusy>(null);

  const run = useCallback(async (
    key: string,
    fn: () => Promise<unknown>,
    opts?: RunOptions,
  ): Promise<boolean> => {
    setBusy(key);
    let ok = true;
    try {
      // 写端点可能 HTTP 200 回 { ok:false }，须按返回值判失败
      const rejected = failureFromResult(await fn());
      if (rejected) throw new Error(rejected);
      if (opts?.success) toast.success(opts.success);
    } catch (e) {
      ok = false;
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
      opts?.onDone?.();
      if (ok && opts?.refresh !== false) supervisorStore.refresh();
    }
    return ok;
  }, []);

  return { busy, run };
}
