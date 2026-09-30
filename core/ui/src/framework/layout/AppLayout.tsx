import type { ReactNode } from "react";
import { cn } from "../utils";

/** AppLayout：响应式主布局（侧边栏 + 主内容区）。
 *  >=641px 侧边栏常驻左列；<=640px 变 fixed 左抽屉，滑入/出与遮罩显隐由 theme/shell.css 按
 *  data-sidebar-open / data-mode 控制——类名与 data-* 属性须与 shell.css 选择器保持同步。 */

export type AppLayoutProps = {
  children: ReactNode;
  /** 侧边栏内容（null 时不渲染左侧栏） */
  sidebar?: ReactNode;
  /** 宽侧边栏模式（如空间分析） */
  wideSidebar?: boolean;
  /** 手机抽屉是否打开（<=640px 生效） */
  sidebarOpen?: boolean;
  /** 关闭抽屉回调（点遮罩 / 选完导航触发） */
  onCloseSidebar?: () => void;
  className?: string;
};

export function AppLayout({
  children,
  sidebar,
  wideSidebar = false,
  sidebarOpen = false,
  onCloseSidebar,
  className,
}: AppLayoutProps) {
  return (
    <div
      data-mode={wideSidebar ? "wide-sidebar" : "classic"}
      data-sidebar-open={sidebarOpen ? "true" : "false"}
      className={cn(
        "fw-layout grid h-full min-h-0 min-w-0 overflow-hidden bg-background max-[640px]:overflow-visible",
        className,
      )}
    >
      {sidebar}
      {children}
      {/* 手机抽屉遮罩：宽屏 display:none，无副作用 */}
      {sidebar && onCloseSidebar ? (
        <div
          aria-hidden="true"
          className="fw-drawer-scrim"
          onClick={onCloseSidebar}
        />
      ) : null}
    </div>
  );
}
