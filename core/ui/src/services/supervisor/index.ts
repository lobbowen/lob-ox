/** 轮询只在装配层 SupervisorApp 启动一次（supervisorStore.start），页面 hook 只订阅。 */
import { useSyncExternalStore } from "react";
import { supervisorStore } from "./polling";

export * from "./types";
export type { SupervisorSnapshot } from "./polling";
export { supervisorApi } from "./client";
export { setStoredAccessKey } from "./client";
// 2xx 响应体里的 {ok:false} 假成功统一判据（写操作由 run() 消费）
export { failureFromResult } from "./client";
export { supervisorStore } from "./polling";
export { pollJob } from "./jobs";
export type { JobState as PollJobState, PollJobOptions, PollJobResult } from "./jobs";

export function useSupervisorData() {
  const snap = useSyncExternalStore(
    supervisorStore.subscribe,
    () => supervisorStore.snapshot,
    () => supervisorStore.snapshot,
  );
  return { snap, refresh: supervisorStore.refresh };
}
