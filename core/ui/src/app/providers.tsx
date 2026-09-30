import type { ReactNode } from "react";
import { ThemeProvider } from "next-themes";
import { ConfirmProvider } from "../framework/ui/confirm";
import { Toaster } from "../framework/ui/sonner";

// 控制面板 Providers：只保留框架级 Provider——ThemeProvider（暗色主题，跟随系统）、
// ConfirmProvider（危险动作确认的唯一出口，见 UI 规范 ui/FRAMEWORK.md）与 Toaster（全局通知）。
// 数据通道由 supervisorStore（services/supervisor）内部轮询，无需全局注入；文案硬编码中文（单一语言产品），无 i18n 依赖。
export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <ThemeProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
    >
      <ConfirmProvider>{children}</ConfirmProvider>
      <Toaster />
    </ThemeProvider>
  );
}
