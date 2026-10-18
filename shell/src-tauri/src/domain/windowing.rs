use tauri::{Emitter, Manager};

const PANEL_PUSH_DELAYS: [u64; 3] = [400, 1200, 2500];

// R7-架构：面板投影判据从「守卫会话语义」改为「进程表里有 running 的内核」。
// 原实现 if/else 两个分支发同一个事件（serving 判定实际无效——死判断），
// 且判据来源 serving_state 已随守卫语义删除。
// （「守卫」是内核被接管前的历史命名，本段保留它是为了说明这套语义为何被废。）
pub(crate) fn go_panel(app: &tauri::AppHandle, force: bool) {
    for (i, delay_ms) in PANEL_PUSH_DELAYS.iter().copied().enumerate() {
        let h = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(delay_ms));
            let url = crate::env::api_base_url();
            let _ = h.emit("shell:goto-panel", serde_json::json!({ "url": url, "seq": i, "force": force }));
        });
    }
}

pub(crate) fn show_main(app: &tauri::AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
        go_panel(app, true);
    }
}

