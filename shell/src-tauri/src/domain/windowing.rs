//! 窗口导航与显示。壳的窗口语义：关窗 = 隐藏到托盘（服务继续常驻，见 main.rs 的 CloseRequested）；
//! 「退出管家」= 停全部服务链（见 `crate::domain::guardctl::shutdown_all`）。

use tauri::{Emitter, Manager};

/// 面板导航的重发拍数与间隔。拍数表与「最后一拍」判据必须同源，故判据取 len()。
const PANEL_PUSH_DELAYS: [u64; 3] = [400, 1200, 2500];

pub(crate) fn go_panel(app: &tauri::AppHandle, force: bool) {
  // 壳框架(shell.html)的 evt listener 在首帧注册；setup 线程的 emit 可能早于注册被丢弃，
  // 故延时重发数次覆盖竞态（listener 就绪后任一次生效即切面板）。
  // force=true（用户重新显示窗口）-> 即使 URL 相同也强制重载，保证拿最新 UI。
    for (i, delay_ms) in PANEL_PUSH_DELAYS.iter().copied().enumerate() {
        let h = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(delay_ms));
            // 每一拍都重新判据并现取 URL（守卫可能已顺延端口），不是重发同一个地址；最后一拍仍不在
            //   服役就回引导页重跑启动链。投未判据的地址只会把引擎错误页留给用户。
            // 判据与 URL 必须同出 `panel_view` 一个答案：主帧那条导航路径不经本函数，在此单独判一次
            //   服役并不能阻止它按未判据的 URL 抢先导航。
            let (url, serving) = crate::domain::guardctl::panel_view();
            if serving {
                let _ = h.emit("shell:goto-panel", serde_json::json!({ "url": url, "seq": i, "force": force }));
            } else if i + 1 == PANEL_PUSH_DELAYS.len() {
                let _ = h.emit("shell:goto-bootstrap", serde_json::json!({}));
            }
        });
    }
}

pub(crate) fn show_main(app: &tauri::AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
  // 每次显示都强制重新导航到面板：WebView 不做陈旧缓存，保证拿最新 UI（force=true）
        go_panel(app, true);
    }
}

// 桌面壳自更新命令定义在 src/commands/mod.rs（命令层只做校验与委托，门禁 G3：main.rs 不得定义
// #[tauri::command]），本文件只负责窗口。三平台同一代码路径：检查 -> 下载 -> minisign 验签 ->
// 平台安装 -> 重启；平台差异（Linux pkexec dpkg -i / macOS .app 替换 / Windows NSIS passive）
// 全部由 tauri-plugin-updater 内部处理，壳侧无平台分支。
