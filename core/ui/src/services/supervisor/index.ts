/** supervisor 宿主适配 - 统一出口：页面经此引入，数据契约见 types.ts、写操作经 supervisorApi、运行态快照经 useSupervisorData。
 *  轮询生命周期：supervisorStore.start() 只在 App 装配层启动一次（SupervisorApp），页面 hook 只订阅不重复启动。 */
import { useSyncExternalStore } from "react";
import { supervisorStore } from "./polling";

export * from "./types";
export type { SupervisorSnapshot } from "./polling";
export { supervisorApi } from "./client";
// 访问密钥本机持久化入口（保存成功后写入 localStorage，供 client 统一带 Bearer）
export { setStoredAccessKey } from "./client";
// 2xx 响应体里的 {ok:false} 假成功统一判据（写操作由 run() 消费）
export { failureFromResult } from "./client";
export { supervisorStore } from "./polling";
// 任务进度轮询：插件/反代 job 的「提交->轮询->终态」闭环。
export { pollJob } from "./jobs";
export type { JobState as PollJobState, PollJobOptions, PollJobResult } from "./jobs";

/** 消费运行态快照（只订阅，不启动轮询）。返回 { snap, refresh }。 */
export function useSupervisorData() {
  const snap = useSyncExternalStore(
    supervisorStore.subscribe,
    () => supervisorStore.snapshot,
    () => supervisorStore.snapshot,
  );
  return { snap, refresh: supervisorStore.refresh };
}
