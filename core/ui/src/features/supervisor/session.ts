import type { SupervisorStatus } from "../../services/supervisor";

/** 内核会话的唯一状态判定。StatusBar 与 OverviewPage 指标区共用，不得各判各的。 */
export type GuardState = "halted" | "running" | "stopped" | "offline" | "auth-failed";

export function guardStateOf(
  s: SupervisorStatus | null | undefined,
  online: boolean,
  authFailed: boolean,
): GuardState {
  const sessionState = s?.sessionState;
  // stopping/stopped 时内核已停，但内核进程仍活着：dshPid/dshPort 是上一轮的残留值，
  // 此刻按「已停止」判定，指标不得再展示旧 PID 与端口。
  //
  // D 态（观测未受管）与「壳已令内核停」也并进这道门（architect 裁选 A：
  // 「并进 :14 那道门」而不是新加 GuardState 变体）：
  //   · `observedOnly` ⇒ DSH 在跑但非本产品管理 ⇒ 若判成 "running"，用户会以为
  //     本产品在管它（而壳退时杀不掉它）⇒ 那正是 E2/C 态要防的错觉；
  //   · `shellHalted`  ⇒ 壳已让内核停 ⇒ 同理，不能因为 dshPid 有残留值就判 running。
  //   ⇒ 两者都归 "halted"（内核仍在，但**不处于本产品管理的运行态**）。
  if (sessionState === "stopping" || sessionState === "stopped") return "halted";
  if (s?.observedOnly) return "halted";
  if (s?.shellHalted) return "halted";
  if (online && s?.dshPid) return "running";
  if (online) return "stopped";
  return authFailed ? "auth-failed" : "offline";
}

/** 内核已停止时 PID/端口不得显示上一轮的残留值。 */
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
