import type { ReactNode } from "react";
import { ThemeProvider } from "next-themes";
import { ConfirmProvider } from "../framework/ui/confirm";
import { Toaster } from "../framework/ui/sonner";

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
