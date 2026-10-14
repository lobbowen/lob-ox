import { useSyncExternalStore } from "react";
import { supervisorStore } from "./polling";

export * from "./types";
export type { SupervisorSnapshot } from "./polling";
export { supervisorApi } from "./client";
export { setStoredAccessKey } from "./client";

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
