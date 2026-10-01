#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]


// 结构化错误模型：IPC 边界统一返回它（前端按 `kind` 分支、并显示后端给的 `hint`）。
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

use std::sync::Mutex;
use tauri::Manager;
use tauri_plugin_updater::UpdaterExt;

pub(crate) struct RunState {
    busy: bool,
    installed: Option<String>,
    latest: Option<String>,
        /// 可测分母的进度比值（0.0~1.0）；`None` = 本步骤**没有**可测分母。只有真实可测的量（下载字节比）才允许写 `Some`：0.0 会同时被读成「没开始」「没有分母」「刚起步」三种含义。
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
        // 运行时守卫入口：服务定义（systemd/launchd/schtasks）只指向 `<壳> --run-guard`。必须在 Tauri 初始化**之前**返回 —— 每次启动重新检测 node/guard 后 exec。
    if std::env::args().any(|a| a == "--run-guard") {
        std::process::exit(domain::cli::cli_run_guard());
    }
        // 无头看护入口：Windows 计划任务（DSH-Supervisor-Watchdog）每 5 分钟调用。判据与启动/面板同一实现（`guardctl::ready`），故必须在 Tauri 初始化之前返回。
    if std::env::args().any(|a| a == "--watchdog") {
        std::process::exit(domain::cli::cli_watchdog());
    }
    bt!("building app");
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            domain::windowing::show_main(app);
        }))
                // 壳自更新插件：强制 minisign 验签；平台安装语义内部处理。未配置 pubkey 时插件仍可注册（check 会失败并返回错误，由引导页按「失败放行」处理）。
                // 该公钥（tauri.conf.json 的 plugins.updater.pubkey）用于校验更新包签名，私钥只在发布方 CI secret、绝不入仓。
                // 换钥后老客户端无法验证新更新：新更新由新私钥签名，老客户端手持的旧公钥验不过。
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(Mutex::new(RunState::default()))
        .invoke_handler(tauri::generate_handler![commands::node_status, commands::core_status, commands::core_plan, commands::core_apply, commands::kernel_update_apply, commands::shell_bridge_contract, commands::guard_start, commands::guard_ready, commands::start_node_install, commands::finish_boot, commands::win_ctl, commands::shell_identity, commands::shell_update_check, commands::shell_update_apply, commands::shell_restart, commands::shell_set_phase, commands::mirror_status, commands::mirror_set, commands::node_latest, commands::mirror_warmup, commands::mirror_cached, commands::shell_panel_url])
        .setup(|app| {
            bt!("setup enter");
            env::migrate_legacy();
                        // 托盘直发本地 API 的端口：显式 DSH_SUPERVISOR_TRAY_PORT 优先，否则**每次点击现取**。不做 setup 期快照：守卫因端口占用顺延过时，快照会把启动/停止/退出全打在没人监听的端口上，而 guardctl 一侧读的是当前值 —— 同一事实两套答案，退出握手就打错了对象。
            let port = || std::env::var("DSH_SUPERVISOR_TRAY_PORT")
                .ok().and_then(|p| p.parse().ok()).unwrap_or_else(env::current_api_port);
            let handle = app.handle().clone();

                        // 壳身份初始化：写 <状态根>/shell/identity.json + shell.log（独立于 DSH）。必须尽量早执行：即使后续任一环节失败，也留下可诊断的落盘痕迹。
            bt!("init_identity...");
            let _ = update::init_identity(&app.package_info().version.to_string());
            bt!("init_identity done");

            crate::mirror::export_on_boot();

                        // 环境判定：Node 缺失或低于最低标准（>=22.12）时由引导页安装；达标直接进面板。探测只触发（分离线程），不得阻塞 setup —— 窗口必须先出现。
            nodeprobe::start();
                        // 镜像测速同样在引导即预热：registry 维度只读这份预热结果；若只由引导页 JS 触发，任何不走 70-boot 的入口（直进面板/脚本页加载失败）都会让那一格永久问号。WARMING 去重，前端若也触发也不会测两遍。
            crate::mirror::warmup_async();
            {
                let h = handle.clone();
                std::thread::spawn(move || {
                                        // 在飞探测最多等 45 秒（与引导页预算一致）；未完成则放弃本次回填，下次 node_status 轮询仍会拿到结果。
                    let out = nodeprobe::status(std::time::Duration::from_secs(45));
                    if let Some(v) = out.version {
                        let st = h.state::<Mutex<RunState>>();
                        st.lock().unwrap_or_else(|e| e.into_inner()).installed = Some(v);
                    }
                });
            }
                        // 单一引导流程：守卫的安装/升级/启动全部由引导页显式驱动（core_plan、core_apply、guard_start、guard_ready），壳启动不并行拉起。
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

            tauri::tray::TrayIconBuilder::with_id("dsh-supervisor-tray")
                .icon(app.default_window_icon().ok_or("no default icon")?.clone())
                .tooltip("dsh-supervisor")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(move |app, event| {
                    match event.id.as_ref() {
                        "show" => domain::windowing::show_main(app),
                                                // 网络 I/O **必须离开 UI 线程**：托盘菜单事件由 UI 线程派发，而 post_local 最多阻塞 60 秒（TCP 连接 + 读写超时）；守卫挂起时点击会把整个界面冻结。改为派发到独立线程：菜单立即响应，结果异步生效。
                        "start" => domain::localhttp::spawn_local_post(port(), "/lifecycle/dsh/start"),
                        "stop" => domain::localhttp::spawn_local_post(port(), "/lifecycle/dsh/stop"),
                        "restart" => domain::localhttp::spawn_local_post(port(), "/lifecycle/dsh/restart"),
                                                // 退出管家 = 完全退出：通知守卫停止全部服务链，随后壳退出。契约：请求内核停被管对象（等回执）-> 由所有者停止守卫 -> 壳退出。同样离开 UI 线程：退出握手最坏可耗时约 70 秒（/session/stop 60s + 轮询 10s）。若在 UI 线程做，窗口卡住会被误认为「程序关不掉」而遭强杀 —— 那会跳过退出握手，留下未停的 DSH。
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
                                        // 必须区分按键与状态：匹配 `Click { .. }`（任意键）会让**右键**也 show_main，把右键菜单顶掉。只响应「左键 + 抬起」，右键交由系统弹出 .menu() 设置的菜单。
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
                                // 关闭窗口行为（读守卫 config.closeAction，系统级开关）：'exit' = 退出管家（通知守卫停止全部服务链 + 壳退出）；默认 'hide' = 隐藏至托盘常驻。必须离开 UI 线程（与托盘 quit 同一纪律）。
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
        .expect("error while running dsh-supervisor-gui");
    bt!("main exit (run returned)");
}
