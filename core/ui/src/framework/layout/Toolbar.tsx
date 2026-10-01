import type { ReactNode } from "react";
import { cn } from "../utils";
import { Progress } from "../ui/progress";

export type ToolbarProps = {
  title: string;
  subtitle?: string;
  progress?: number | null;
  actions?: ReactNode;
  menuButton?: ReactNode;
  className?: string;
};

export function Toolbar({
  title,
  subtitle,
  progress,
  actions,
  menuButton,
  className,
}: ToolbarProps) {
  const busy = progress != null;

  return (
    <header
      className={cn(
        "fw-toolbar grid min-h-[76px] min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-4 border-b border-border/60 bg-background px-7 max-[980px]:px-6 max-[640px]:gap-2.5 max-[640px]:px-3 max-[640px]:min-h-[52px]",
        className,
      )}
    >
      {menuButton ? (
        <div className="hidden max-[640px]:block">{menuButton}</div>
      ) : null}

      <div className="min-w-0">
        <h1 className="truncate text-2xl font-bold leading-tight tracking-normal text-foreground max-[640px]:text-base max-[640px]:font-semibold">
          {title}
        </h1>
        {subtitle ? (
          <span className="mt-1.5 block overflow-hidden text-ellipsis whitespace-nowrap text-sm leading-tight text-muted-foreground max-[640px]:hidden">
            {subtitle}
          </span>
        ) : null}
      </div>

      <div className="flex items-center justify-end gap-4 max-[640px]:gap-2 max-[640px]:[&_button]:h-7 max-[640px]:[&_button]:px-2.5 max-[640px]:[&_button]:text-xs">
        {busy ? (
          <div className="hidden w-[190px] max-[640px]:hidden">
            <Progress value={progress} />
          </div>
        ) : null}
        {actions}
      </div>
    </header>
  );
}
