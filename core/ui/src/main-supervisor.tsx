/** dsh-supervisor 控制面板入口（唯一产品入口），构建后由内核 API 进程同源托管；React 挂载时 createRoot 自动替换 #root 内的品牌启动壳。
 *  资源一致性由架构保证（无需自愈/强制刷新脚本）：后端 HTML no-store、资源文件名带内容哈希、宿主每次显示窗口重新导航到 /。 */
import React from "react";
import ReactDOM from "react-dom/client";
// 设计令牌 + Tailwind（UI 全部样式来源，唯一入口在此）
import "./framework/theme";
import { AppProviders } from "./app/providers";
import { SupervisorApp } from "./features/supervisor/SupervisorApp";

// 桌面程序禁用鼠标右键：右键在壳窗口会触发 WebKit 上下文菜单 / 误触进入错误状态，
// 全局拦截 contextmenu。
window.addEventListener("contextmenu", (e) => e.preventDefault());

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <AppProviders>
      <SupervisorApp />
    </AppProviders>
  </React.StrictMode>,
);
