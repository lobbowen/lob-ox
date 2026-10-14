import { useSyncExternalStore } from "react";
import { supervisorStore } from "./polling";

export * from "./types";
export { supervisorApi } from "./client";
export { setStoredAccessKey } from "./client";

export { failureFromResult } from "./client";
export { supervisorStore } from "./polling";
export { pollJob } from "./jobs";
// 任务轮询的结果类型只有 pollJob 一个消费面，直接随函数一起导出，不另设重导出行。
export type { PollJobOptions, PollJobResult, JobState } from "./jobs";

export function useSupervisorData() {
  const snap = useSyncExternalStore(
    supervisorStore.subscribe,
    () => supervisorStore.snapshot,
    () => supervisorStore.snapshot,
  );
  return { snap, refresh: supervisorStore.refresh };
}
