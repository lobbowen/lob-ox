import type { ReactNode } from "react";
import { cn } from "../utils";

export type AppShellProps = {
  children: ReactNode;
  mode?: "classic" | "wide-sidebar";
  className?: string;
};

export function AppShell({ children, mode = "classic", className }: AppShellProps) {
  return (
    <main
      data-mode={mode}
      data-host="web"
      className={cn(
        "fw-shell grid h-full w-full overflow-hidden max-[640px]:h-auto max-[640px]:min-h-dvh max-[640px]:overflow-x-clip max-[640px]:overflow-y-visible",
        "grid-rows-[minmax(0,1fr)] max-[640px]:grid-rows-[auto]",
        className,
      )}
    >
      {children}
    </main>
  );
}
