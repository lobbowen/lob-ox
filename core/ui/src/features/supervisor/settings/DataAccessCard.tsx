import { useSupervisorData } from "../../../services/supervisor";
import { cn } from "../../../framework/utils";

/**
 * E3：数据目录权限收口的三态卡（product-manager 裁：放**设置页「访问」卡**，
 * 不放 OverviewPage ⇒ OverviewPage 是「运行状态」，而权限收口是「配置事实」）。
 *
 * 三态（`status.js:23-25` 的三个分支）：
 *   · `true`  = 已收口（数组非空且**每一条**都 ok）
 *   · `false` = 未收口（有记录但存在不 ok 的）
 *   · `null`  = **未探测**（`_fileProtectStatus` 不是数组 ⇒ 内核没给）
 *
 * ⚠️ `null` **不得显示成「未收口」**：那正是「未知」与「坏」的混淆——
 * 与 `EnvironmentCard.tsx:15` 的「未探必须显示成『未探测』」和 `:32-35` 的
 * 「null = 判不出，不得显示成『不通』」是同一判据（不塌缩）。
 */
function protectText(v: boolean | null | undefined): { label: string; tone: "ok" | "warn" | "off" } {
  if (v === true) return { label: "已收口", tone: "ok" };
  if (v === false) return { label: "未收口", tone: "warn" };
  return { label: "未探测", tone: "off" };
}

export function DataAccessCard() {
  const { snap } = useSupervisorData();
  const s = snap.status;
  const st = protectText(s?.dataDirProtected);

  return (
    <div className="rounded-lg border bg-card p-4">
      <div className="text-sm font-medium">数据目录访问</div>
      <div className="mt-1 text-xs text-muted-foreground">
        内核数据目录的权限收口状态。未收口时同机其他用户可能读到内核的状态文件（含管理令牌）。
      </div>
      <div className="mt-3 flex items-center gap-2">
        <span
          className={cn(
            "inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium",
            st.tone === "ok" && "bg-status-ok/10 text-status-ok",
            st.tone === "warn" && "bg-status-warn/10 text-status-warn",
            st.tone === "off" && "bg-muted text-muted-foreground",
          )}
        >
          {st.label}
        </span>
        {st.tone === "off" ? (
          <span className="text-xs text-muted-foreground">
            内核本轮未给出该事实 ⇒ 与「未收口」是两件事
          </span>
        ) : null}
      </div>
    </div>
  );
}
