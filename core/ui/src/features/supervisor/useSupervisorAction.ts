/**
 * 共享写动作 hook：setBusy(key) -> await api -> 成/败 toast -> onDone + 可选快照刷新。
 * refresh 默认 true（仅本页数据时置 false 并自管 onDone）；key 用于按钮级忙碌态。
 */
import { useCallback, useState } from "react";
import { toast } from "sonner";
import { failureFromResult, supervisorStore } from "../../services/supervisor";

export type ActionBusy = string | null;

export type RunOptions = {
  /** 成功 toast 文案 */
  success?: string;
  /** 是否刷新全局快照（默认 true；仅本页数据时置 false 并自管 onDone） */
  refresh?: boolean;
  /** 后置动作（无论成败），如重载页面列表 */
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
      // 部分写端点在 HTTP 200 里回 { ok:false, error }（http() 只看状态码）：按返回值判失败；页面自管反馈不受影响
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
