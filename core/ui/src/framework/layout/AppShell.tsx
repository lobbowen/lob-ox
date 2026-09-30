import type { ReactNode } from "react";
import { cn } from "../utils";

/**
 * AppShell：应用最外层容器，纯网页布局（铺满视口）。分体架构：窗口外观（圆角卡片/窗口栏/拖动）
 * 全部由壳（Tauri 侧 shell.html 自绘窗口）承担，内核/面板是纯网页，本组件不含任何窗口逻辑。
 */

export type AppShellProps = {
  children: ReactNode;
  /** 布局模式：classic（标准侧边栏）/ wide-sidebar（宽侧边栏，如空间分析） */
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
