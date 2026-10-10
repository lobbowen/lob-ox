use tauri::{Emitter, Manager};

const PANEL_PUSH_DELAYS: [u64; 3] = [400, 1200, 2500];

pub(crate) fn go_panel(app: &tauri::AppHandle, force: bool) {
    
    for (i, delay_ms) in PANEL_PUSH_DELAYS.iter().copied().enumerate() {
        let h = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(delay_ms));
                        
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
        go_panel(app, true);
    }
}

