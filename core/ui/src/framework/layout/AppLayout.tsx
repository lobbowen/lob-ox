import type { ReactNode } from "react";
import { cn } from "../utils";

/** 类名与 data-* 属性须与 theme/shell.css 选择器保持同步。 */

export type AppLayoutProps = {
  children: ReactNode;
  sidebar?: ReactNode;
  wideSidebar?: boolean;
  sidebarOpen?: boolean;
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
