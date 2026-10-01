import React from "react";
import ReactDOM from "react-dom/client";
import "./framework/theme";
import { AppProviders } from "./app/providers";
import { SupervisorApp } from "./features/supervisor/SupervisorApp";

// 桌面壳窗口右键会触发 WebKit 上下文菜单，全局禁用。
window.addEventListener("contextmenu", (e) => e.preventDefault());

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <AppProviders>
      <SupervisorApp />
    </AppProviders>
  </React.StrictMode>,
);
