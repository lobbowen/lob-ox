/** supervisor 展示基件：状态点/胶囊/卡片/指标等；一律使用框架令牌，页面零硬编码。 */
import type { ReactNode } from "react";
import { cn } from "../../framework/utils";
import type { Tone } from "./nav";

/** 语义状态点（呼吸光晕）：phase/守护/运行状态 */
export function ToneDot({ tone = "off", ping = false, className }: { tone?: Tone; ping?: boolean; className?: string }) {
  const inner = tone === "ok" ? "bg-status-ok shadow-[0_0_6px_2px_var(--status-ok-ring)]"
    : tone === "err" ? "bg-status-error shadow-[0_0_6px_2px_var(--status-error-ring)]"
    : tone === "warn" ? "bg-warning"
    : tone === "boot" ? "bg-status-brand shadow-[0_0_6px_2px_var(--status-brand-ring)]"
    : "bg-muted-foreground/50";
  return (
    <span aria-hidden="true" className={cn("relative inline-flex size-2 shrink-0 items-center justify-center", className)}>
      {ping ? (
        <span className={cn(
          "absolute inline-flex size-full animate-ping rounded-full",
          tone === "ok" ? "bg-status-ok-soft opacity-75" : "bg-transparent",
        )} style={tone === "ok" ? { animationDuration: "2s" } : undefined} />
      ) : null}
      <span className={cn("relative inline-flex size-2 rounded-full", inner)} />
    </span>
  );
}

/** 语义胶囊（状态徽标），用 token 语义色 */
export function Pill({ tone = "off", className, children }: { tone?: Tone; className?: string; children: ReactNode }) {
  return (
    <span className={cn(
      "inline-flex h-5 shrink-0 items-center whitespace-nowrap rounded-full px-2 text-xs font-semibold leading-none",
      tone === "ok" && "bg-success-background text-success",
      tone === "err" && "bg-careful-background text-careful",
      tone === "warn" && "bg-warning-background text-warning",
      tone === "boot" && "bg-primary/10 text-primary",
      tone === "off" && "bg-muted text-muted-foreground",
      className,
    )}>
      {children}
    </span>
  );
}

/** 结果卡片容器（白底圆角描边） */
export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div className={cn("overflow-hidden rounded-lg border border-border bg-card shadow-[0_1px_2px_rgba(15,23,42,0.04)]", className)}>
      {children}
    </div>
  );
}

/** 卡片标题行：标题/副标题 + 右侧操作区 */
export function CardTitle({ title, subtitle, actions, className }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <div className={cn("flex min-h-[52px] items-center justify-between gap-4 border-b border-border/70 bg-muted px-5", className)}>
      <div className="min-w-0">
        <strong className="block truncate text-sm font-semibold leading-tight text-foreground">{title}</strong>
        {subtitle ? <span className="mt-1 block text-xs leading-tight text-muted-foreground">{subtitle}</span> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  );
}

/** 单指标（label + value，值可 mono/warn） */
export function Metric({ icon, label, value, mono = false, warn = false, className }: { icon?: ReactNode; label: string; value: ReactNode; mono?: boolean; warn?: boolean; className?: string }) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-2", className)}>
      <div className={cn("flex items-center gap-1.5 text-xs text-muted-foreground", warn && "text-destructive")}>
        {icon}
        <span className="truncate">{label}</span>
      </div>
      <strong className={cn(
        "truncate text-lg font-semibold tabular-nums leading-none",
        mono && "font-mono", warn ? "text-destructive" : "text-foreground",
      )}>
        {value}
      </strong>
    </div>
  );
}

/** 用量框：label+icon 上 / 主值下，白底描边小框并排；危险态(>=100/rate-limited)主值用 destructive。 */
export function QuotaBox({ icon, label, value, note, danger = false }: {
  icon?: ReactNode; label: string; value: ReactNode; note?: ReactNode; danger?: boolean;
}) {
  return (
    <div className="grid min-h-[52px] min-w-0 flex-1 grid-cols-[auto_minmax(0,1fr)] items-center gap-x-1.5 rounded-md border border-border bg-card px-3 py-2">
      <span className="text-muted-foreground">{icon}</span>
      <span className="overflow-hidden text-ellipsis whitespace-nowrap text-xs leading-tight text-muted-foreground">{label}</span>
      <strong className={cn("col-span-full mt-1 truncate text-base font-semibold leading-none tabular-nums", danger ? "text-destructive" : "text-foreground")}>{value}</strong>
      {note ? <span className="col-span-full mt-1 truncate text-[11px] leading-tight text-muted-foreground">{note}</span> : null}
    </div>
  );
}

/** 域徽标：原生/沙箱 */
export function DomainBadge({ domain }: { domain: "native" | "sandbox" }) {
  return <Pill tone={domain === "native" ? "boot" : "off"}>{domain === "native" ? "原生" : "沙箱"}</Pill>;
}

/** 等宽截断文本 */
export function MonoEllipsis({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span className={cn("max-w-[180px] overflow-hidden text-ellipsis whitespace-nowrap font-mono text-sm leading-tight text-muted-foreground", className)}>
      {children}
    </span>
  );
}
