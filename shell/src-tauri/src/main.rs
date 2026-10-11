#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod error;
mod bounded;
mod brand;
mod core;
mod env;
mod bridge;
mod mirror;
mod nodeprobe;
mod node;
mod runtime_contract;
mod core_contract;
mod shell_report;
mod commands;
mod domain;
mod platform;
mod update;
mod update_plan;
mod release_channel;
mod state_reconcile;
mod process_manager;

use std::sync::Mutex;
use tauri::Manager;
use tauri_plugin_updater::UpdaterExt;

pub(crate) struct RunState {
    busy: bool,
    installed: Option<String>,
    latest: Option<String>,
        
    progress: Option<f32>,
    status: String,
    logs: Vec<String>,
    error: Option<String>,
}

impl Default for RunState {
    fn default() -> Self {
        RunState { busy: false, installed: None, latest: None, progress: None, status: "探测中…".into(), logs: vec![], error: None }
    }
}

pub(crate) fn log(state: &RunState) -> serde_json::Value {
    serde_json::json!({
        "busy": state.busy,
        "installed": state.installed,
        "latest": state.latest,
        "progress": state.progress,
        "status": state.status,
        "logs": state.logs,
        "error": state.error,
    })
}

fn shell_update_plan_text() -> String {
    let v = env!("CARGO_PKG_VERSION").to_string();
    let id = update::init_identity(&v);
    
    crate::state_reconcile::reconcile_once(&v);
    let mut out = String::new();
    out.push_str(&format!("shell_version={}", id.get("version").and_then(|x| x.as_str()).unwrap_or("?")));
    out.push_str(&format!(" platform={}", id.get("platform").and_then(|x| x.as_str()).unwrap_or("?")));
    out.push_str(&format!(" arch={}", id.get("arch").and_then(|x| x.as_str()).unwrap_or("?")));
    out.push_str(&format!(" install_kind={}", update::install_kind()));
    out.push_str(&format!(" self_update_capable={}", update::self_update_capable()));
    out.push_str(&format!(" state_dir={}", update::state_dir().display()));
    out
}

fn shell_updater(
    app: &tauri::AppHandle,
    timeout: std::time::Duration,
) -> Result<tauri_plugin_updater::Updater, String> {
    let mut builder = app.updater_builder().timeout(timeout);
    let endpoints: Vec<tauri::Url> = crate::mirror::load()
        .shell
        .iter()
        .filter_map(|s| tauri::Url::parse(s).ok())
        .collect();
    if !endpoints.is_empty() {
        builder = builder
            .endpoints(endpoints)
            .map_err(|e| format!("更新端点配置无效: {}", e))?;
    }
    builder
        .build()
        .map_err(|e| format!("更新器不可用: {}", e))
}

fn main() {
    macro_rules! bt {
        ($($a:tt)*) => {
            crate::update::log(&format!("[boot] {}", format!($($a)*)));
        };
    }
    bt!("main enter");
    bt!(
        "state-root schema={} root={} supervisor={} shell={}",
        env::STATE_ROOT_SCHEMA,
        env::state_root().display(),
        env::supervisor_dir().display(),
        env::shell_dir().display()
    );
    if std::env::args().any(|a| a == "--mirror-plan") {
        std::process::exit(domain::cli::cli_mirror_plan());
    }
    if std::env::args().any(|a| a == "--env-plan") {
        std::process::exit(domain::cli::cli_env_plan());
    }
    if std::env::args().any(|a| a == "--service-plan") {
        std::process::exit(domain::cli::cli_service_plan());
    }
    if std::env::args().any(|a| a == "--node-plan") {
        std::process::exit(domain::cli::cli_plan());
    }
    if std::env::args().any(|a| a == "--platform-matrix") {
        println!("{}", platform::matrix_text());
        std::process::exit(0);
    }
    if std::env::args().any(|a| a == "--core-plan") {
        println!("{}", core::plan_text());
        std::process::exit(0);
    }
    if std::env::args().any(|a| a == "--shell-update-plan") {
        println!("{}", shell_update_plan_text());
        std::process::exit(0);
    }
        
        
    if std::env::args().any(|a| a == "--run-guard") {
        std::process::exit(domain::cli::cli_run_guard());
    }
        
    if std::env::args().any(|a| a == "--watchdog") {
        std::process::exit(domain::cli::cli_watchdog());
    }
    
    
    
    
    {
        let v = env!("CARGO_PKG_VERSION").to_string();
        for (name, outcome) in crate::state_reconcile::reconcile_once(&v) {
            match outcome {
                crate::state_reconcile::Outcome::Unchanged => {}
                crate::state_reconcile::Outcome::Rewritten(why) => {
                    eprintln!("[state-reconcile] {} 已重写: {}", name, why);
                }
                crate::state_reconcile::Outcome::Skipped(why) => {
                    eprintln!("[state-reconcile] {} 需关注: {}", name, why);
                }
            }
        }
    }
    bt!("building app");
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            domain::windowing::show_main(app);
        }))
                
                
                
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(Mutex::new(RunState::default()))
        .manage(std::sync::Arc::new(crate::process_manager::ProcessManager::new()))
        .invoke_handler(tauri::generate_handler![commands::node_status, commands::system_node_ready, commands::boot_trace, commands::core_status, commands::core_plan, commands::core_apply, commands::kernel_update_apply, commands::shell_bridge_contract, commands::guard_start, commands::guard_ready, commands::start_node_install, commands::finish_boot, commands::win_ctl, commands::shell_identity, commands::shell_update_check, commands::shell_update_apply, commands::shell_restart, commands::shell_set_phase, commands::mirror_status, commands::mirror_set, commands::node_latest, commands::mirror_warmup, commands::mirror_cached, commands::shell_panel_url, commands::pm_status])
        .setup(|app| {
            bt!("setup enter");
            
            {
                let pm = app.state::<std::sync::Arc<crate::process_manager::ProcessManager>>();
                tauri::async_runtime::spawn(crate::process_manager::mgmt::run(pm.inner().clone()));
            }
            {
                let pm = app.state::<std::sync::Arc<crate::process_manager::ProcessManager>>();
                tauri::async_runtime::spawn(crate::process_manager::supervisor::drive(pm.inner().clone()));
            }
            env::migrate_legacy();
                        
            let port = || std::env::var("DSH_SUPERVISOR_TRAY_PORT")
                .ok().and_then(|p| p.parse().ok()).unwrap_or_else(env::current_api_port);
            let handle = app.handle().clone();

                        
            bt!("init_identity...");
            let _ = update::init_identity(&app.package_info().version.to_string());
            bt!("init_identity done");

            crate::mirror::export_on_boot();

                        
            nodeprobe::start();
                        
            crate::mirror::warmup_async();
            {
                let h = handle.clone();
                std::thread::spawn(move || {
                                        
                    let out = nodeprobe::status(std::time::Duration::from_secs(45));
                    if let Some(v) = out.version {
                        let st = h.state::<Mutex<RunState>>();
                        st.lock().unwrap_or_else(|e| e.into_inner()).installed = Some(v);
                    }
                });
            }
                        
            std::thread::spawn(move || {
                if let Ok(c) = node::latest_lts() {
                    let v = c.version.clone();
                    let state = handle.state::<Mutex<RunState>>();
                    let mut s = state.lock().unwrap_or_else(|e| e.into_inner());
                    s.latest = Some(v.clone());
                    drop(s);
                }
            });

            bt!("setup: building tray");
            let show_m = tauri::menu::MenuItem::with_id(app, "show", "显示控制面板", true, None::<&str>)?;
            let start = tauri::menu::MenuItem::with_id(app, "start", "启动 DSH", true, None::<&str>)?;
            let stop = tauri::menu::MenuItem::with_id(app, "stop", "停止 DSH", true, None::<&str>)?;
            let restart = tauri::menu::MenuItem::with_id(app, "restart", "重启一次", true, None::<&str>)?;
            let quit = tauri::menu::MenuItem::with_id(app, "quit", "退出管家", true, None::<&str>)?;
            let menu = tauri::menu::Menu::with_items(app, &[&show_m, &start, &stop, &restart, &quit])?;

            tauri::tray::TrayIconBuilder::with_id("lobox-tray")
                .icon(app.default_window_icon().ok_or("no default icon")?.clone())
                .tooltip("lobox")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(move |app, event| {
                    match event.id.as_ref() {
                        "show" => domain::windowing::show_main(app),
                                                
                        "start" => domain::localhttp::spawn_local_post(port(), "/lifecycle/dsh/start"),
                        "stop" => domain::localhttp::spawn_local_post(port(), "/lifecycle/dsh/stop"),
                        "restart" => domain::localhttp::spawn_local_post(port(), "/lifecycle/dsh/restart"),
                                                
                        "quit" => {
                            let h = app.clone();
                            let p = port();
                            std::thread::spawn(move || {
                                domain::guardctl::shutdown_all(p);
                                h.exit(0);
                            });
                        }
                        _ => {}
                    }
                })
                .on_tray_icon_event(|tray, event| {
                                        
                    if let tauri::tray::TrayIconEvent::Click {
                        button: tauri::tray::MouseButton::Left,
                        button_state: tauri::tray::MouseButtonState::Up,
                        ..
                    } = event
                    {
                        domain::windowing::show_main(tray.app_handle());
                    }
                })
                .build(app)?;

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                                
                if env::close_action() == "exit" {
                    let h = window.app_handle().clone();
                    let port = env::current_api_port();
                    api.prevent_close();
                    std::thread::spawn(move || {
                        domain::guardctl::shutdown_all(port);
                        h.exit(0);
                    });
                    return;
                }
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running lobox-shell");
    bt!("main exit (run returned)");
}
