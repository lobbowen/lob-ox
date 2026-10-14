import type { SupervisorStatus } from "../../services/supervisor";

/** 守卫会话的唯一状态判定。StatusBar 与 OverviewPage 指标区共用，不得各判各的。 */
export type GuardState = "halted" | "running" | "stopped" | "offline" | "auth-failed";

export function guardStateOf(
  s: SupervisorStatus | null | undefined,
  online: boolean,
  authFailed: boolean,
): GuardState {
  const sessionState = s?.sessionState;
  // stopping/stopped 时内核已停，但守卫进程仍活着：dshPid/dshPort 是上一轮的残留值，
  // 此刻按「已停止」判定，指标不得再展示旧 PID 与端口。
  if (sessionState === "stopping" || sessionState === "stopped") return "halted";
  if (online && s?.dshPid) return "running";
  if (online) return "stopped";
  return authFailed ? "auth-failed" : "offline";
}

/** 守卫已停止时 PID/端口不得显示上一轮的残留值。 */
export function processIdentity(
  state: GuardState,
  s: SupervisorStatus | null | undefined,
): { pid: string; port: string } {
  if (state === "halted") return { pid: "已停止", port: "已停止" };
  return {
    pid: s?.dshPid ? String(s.dshPid) : "—",
    port: s?.dshPort ? String(s.dshPort) : "—",
  };
}
