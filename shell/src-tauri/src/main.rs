#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod error;
mod atomic_write;
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
mod fault;
mod telemetry;
mod transfer;
mod runtime;

use std::sync::Mutex;
use tauri::Manager;
use tauri_plugin_updater::UpdaterExt;

pub(crate) struct RunState {
    busy: bool,
    installed: Option<String>,
    latest: Option<String>,
        
    progress: Option<f32>,
    status: String,
    error: Option<String>,
}

impl Default for RunState {
    fn default() -> Self {
        RunState { busy: false, installed: None, latest: None, progress: None, status: "探测中…".into(), error: None }
    }
}

pub(crate) fn log(state: &RunState) -> serde_json::Value {
    serde_json::json!({
        "busy": state.busy,
        "installed": state.installed,
        "latest": state.latest,
        "progress": state.progress,
        "status": state.status,
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
    // 引导期痕迹。走 telemetry 而非裸日志：这些行是「卡在哪一步」的唯一证据，
    // 崩溃现场（boot-trace fatal）就是从这里来的。
    macro_rules! bt {
        ($($a:tt)*) => {
            crate::telemetry::event::info(
                "boot.step",
                "boot",
                serde_json::json!({ "line": format!($($a)*) }),
            );
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
        
    
    
    
    
    {
        let v = env!("CARGO_PKG_VERSION").to_string();
        for (name, outcome) in crate::state_reconcile::reconcile_once(&v) {
            match outcome {
                crate::state_reconcile::Outcome::Unchanged => {}
                crate::state_reconcile::Outcome::Rewritten(why) => {
                    crate::telemetry::event::info("reconcile.rewritten", "state_reconcile", serde_json::json!({ "name": name, "why": why }));
                }
                crate::state_reconcile::Outcome::Skipped(why) => {
                    crate::telemetry::event::warn("reconcile.needs_attention", "state_reconcile", serde_json::json!({ "name": name, "why": why }));
                }
            }
        }
    }
    bt!("building app");
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            domain::windowing::show_main(app);
        }))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(Mutex::new(RunState::default()))
        .manage(crate::process_manager::handle())
        .invoke_handler(tauri::generate_handler![commands::node_status, commands::system_node_ready, commands::boot_trace, commands::core_status, commands::core_plan, commands::core_apply, commands::kernel_update_apply, commands::shell_bridge_contract, commands::guard_start, commands::guard_ready, commands::core_full_status, commands::start_node_install, commands::finish_boot, commands::win_ctl, commands::shell_identity, commands::shell_update_check, commands::shell_update_apply, commands::shell_restart, commands::shell_set_phase, commands::mirror_status, commands::mirror_set, commands::node_latest, commands::mirror_warmup, commands::mirror_cached, commands::shell_panel_url, commands::pm_status, commands::telemetry_tail])
        .setup(|app| {
            bt!("setup enter");
            
            {
                let pm = app.state::<std::sync::Arc<crate::process_manager::ProcessManager>>();
                tauri::async_runtime::spawn(crate::process_manager::mgmt::run(pm.inner().clone()));
            }
            {
                let pm = app.state::<std::sync::Arc<crate::process_manager::ProcessManager>>();
                crate::process_manager::spawn_healer(pm.inner().clone());
            }
            // 件 1（重做）：关机/注销守卫。形态 B——bounded 自建 message-only 窗口，
            // 而它的消息循环是**阻塞**的（GetMessageW）⇒ 必须放专用线程，
            // 否则会卡住 setup 后面的启动路径（壳起不来）。
            // Unix 侧无操作（SIGTERM 是真信号，走 RunEvent::ExitRequested 那条）。
            std::thread::spawn(|| {
                if !crate::bounded::install_end_session_guard(|| {
                    crate::domain::guardctl::shutdown_all_with_reason("session_ending");
                }) {
                    crate::telemetry::event::warn(
                        "process.end_session_guard_unavailable",
                        "main",
                        serde_json::json!({ "reason": "message-only 窗口创建失败 ⇒ 关机/注销时杀不掉内核" }),
                    );
                }
            });
            env::migrate_legacy();
                        
            // 唯一端口解析：托盘动作与 CloseRequested 共用（见 env::resolved_api_port）。
            let port = env::resolved_api_port;
            let handle = app.handle().clone();

                        
            bt!("init_identity...");
            let _ = update::init_identity(&app.package_info().version.to_string());
            bt!("init_identity done");

            crate::mirror::export_on_boot();
    // 镜像源周期重测：warmup_async 只测一轮，而内核采用壳侧测速记录有 30 分钟 TTL，
    // 不持续生产的话长跑机器上内核必然拿不到、镜像源选择退化为配置顺序。
    crate::mirror::reprobe_forever();

                        
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
                            std::thread::spawn(move || {
                                domain::guardctl::shutdown_all();
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
                    api.prevent_close();
                    std::thread::spawn(move || {
                        domain::guardctl::shutdown_all();
                        h.exit(0);
                    });
                    return;
                }
                let _ = window.hide();
                api.prevent_close();
            }
        })
        // 件 1：退出兜底。`shutdown_all` 此前只在两个**用户主动动作**里被调
        // （托盘 quit `:250`、窗口关闭且 close_action=="exit" `:278`）。
        // ⇒ `kill` 默认信号（SIGTERM）、终端关闭、服务管理器停服都不经过它
        //   ⇒ 内核继续活着。
        //
        // 钩子选型（docs.rs tauri 2.12.4，逐字据）：
        //   · `Builder::run` 不提供事件回调——它只跑事件循环；
        //   · `App::run(cb)` 有 `RunEvent` 回调，但文档明言
        //     "This function never returns. When the application finishes,
        //      the process is exited directly using std::process::exit.
        //      See `run_return` if you need to run code after the application
        //      event loop exits." ⇒ 回调返回后进程即退，`shutdown_all` 内的
        //     taskkill 可能没跑完（且后续 `bt!` 永不执行）；
        //   · **`App::run_return(cb) -> i32`**：返回退出码、后续代码可执行、
        //     且回调收到 `RunEvent::ExitRequested { api, .. }`（"The app is
        //     about to exit"）⇒ 在退出**前**同步跑 `shutdown_all`。
        //     docs.rs 的示例正是 `run_return` + `ExitRequested { api.prevent_exit() }`。
        //
        // ⚠️ **不调 `api.prevent_exit()`**——文档明言它是 "Prevents the app from
        //    exiting"（阻止退出）。若在 `shutdown_all` 之后调它，壳会**永远退不掉**。
        //    我需要的是「退出前同步做清理」，不是「取消退出」：
        //    `ExitRequested` 在退出**前**触发，回调里同步跑完 `shutdown_all`，
        //    不碰 `api` ⇒ 回调返回后 Tauri 继续走退出流程 ⇒ 清理与退出两全。
        //    （docs.rs 示例里的 `prevent_exit()` 是给「想拦截退出」的场景，
        //     本例不拦截，只借它的触发时机。）
        //
        // ⚠️ 本层**不覆盖** `kill -9` / 任务管理器强杀：那些连 `ExitRequested`
        //   都不发。那个缺口由件 A（JobObject）覆盖，而件 A 因 2' 被 Node API
        //   阻塞（Node `spawn` 不暴露 `creationFlags` ⇒ 内核侧的浏览器/npm 无法
        //   `CREATE_BREAKAWAY_FROM_JOB` 逃出 job）暂不推，见 bounded.rs:128-160 记账。
        //
        // 幂等：主动退出路径（:253/:282）已调过 `shutdown_all` 时，本层再调一次
        // 会把已停的 pid 再 kill ⇒ `KillOutcome::AlreadyGone`（成功），
        // 留痕记 `signal=already_gone` ⇒ 可与本层停的区分。
        // kill 同步性已核：`kill_tree_pid` → `bounded::run(cmd, 10s)` →
        // `run_inner` → `child.wait()`（bounded.rs:512/538）⇒ 同步等 taskkill 完成，
        // 10s 超时兜底。故 `ExitRequested` 回调里同步调用不会让退出无限悬挂。
        .build(tauri::generate_context!())
        .expect("error while building lobox-shell");
    let code = app.run_return(|_app_handle, event| {
        if let tauri::RunEvent::ExitRequested { .. } = event {
            domain::guardctl::shutdown_all();
        }
    });
    // `run_return` 返回 Tauri 事件循环的既定退出码（含 `AppHandle::exit(code)` 传入的
    // 值）。原实现用 `Builder::run`（文档：进程由 Tauri 直接 `std::process::exit`，不
    // 返回码），改 `run_return` 后码由我们接收并传出，否则退出码恒 0。
    // 当前 `shutdown_all` 不返回码（失败只留痕），故透传 Tauri 给的码，不自行改。
    bt!("main exit (run returned)");
    std::process::exit(code);
}
