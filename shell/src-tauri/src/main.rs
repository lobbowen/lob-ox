#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// dsh-supervisor-gui：桌面壳 + 环境引导器（开源：dsh-supervisor-launcher）。
// 职责：探测系统 Node.js，缺失/过旧时经引导页一键安装官方最新 LTS；就绪后定位已装内核、
//   拉起守卫 daemon、打开面板（端口由内核 config.apiPort 决定）。内核闭源，壳不内嵌内核资产。
// 托盘常驻：关窗 = 隐藏；菜单动作直发本地 API（裸 TCP，无额外依赖）。

// 有界子进程执行（公共设施）：所有外部命令一律经它，避免「无界阻塞分散潜伏」。
// 结构化错误模型：IPC 边界统一返回它（前端按 `kind` 分支、并显示后端给的 `hint`）。
mod error;
mod bounded;
mod core;
mod env;
// 面板与壳的消息桥契约：内核更新单写入者；版本/消息类型/命令名的唯一事实源。
mod bridge;
// 镜像源适配（壳自持）：装机时无内核，三处下载都必须自带镜像能力。
mod mirror;
// 有界 Node 探测（架构层修复）：分离线程 + 有界等待 + 缓存 + 追踪。
// 根因：探测内含无界阻塞系统调用，且被命令 await —— 详见本文件根因说明。
mod nodeprobe;
mod node;
// 运行期启动契约：Node/npm 的**单一事实源**；安装/服务定义/spawn 都只读它。
mod runtime_contract;
// 内核位置契约：内核**位置**的单一事实源（core.json）；安装成功后壳写，locate 先读。
mod core_contract;
// 环境观测报告（P7）：壳所见 Node/npm/镜像源/前缀的投放侧，内核读它做环境表单。
mod shell_report;
// 平台适配层：**全仓唯一的平台分支所在地**（门禁 G1）。
// 服务定义与启停在同一对象（platform::service::ServiceControl），加平台不需要改两处不同层。
/// 业务层（平台无关）：从 main.rs 拆出的可独立测试的模块。
/// IPC 命令边界层（只做校验与委托）。
mod commands;
mod domain;
mod platform;
// 桌面壳自更新 + 落盘日志 + 身份上报
mod update;
// 统一更新决策模型：壳与内核**同一形状**（机制层统一）。
mod update_plan;
// 发布通道选版：**契约冻结算法**的唯一实现。
//   选版规则（rollback/canary/latest/versions 兜底 + 灰度名单）与"怎么装/怎么探测镜像"无关；
//   独立成模块后每个分支都能被纯函数单元测试直接覆盖（门禁 RC-G1/RC-G2）。
mod release_channel;

use std::sync::Mutex;
// `Manager`：main.rs 里只用于 `state::<Mutex<RunState>>()`（快照读取与托盘回调）。
//   `Emitter` 不再需要：安装事件的发射已整体迁入 `domain::install`（B4）。
use tauri::Manager;
// app.updater()：Tauri 官方更新器入口（强制 minisign 验签）。
use tauri_plugin_updater::UpdaterExt;

pub(crate) struct RunState {
    busy: bool,
    installed: Option<String>, // 系统当前 node 版本
    latest: Option<String>,    // 官方最新 LTS
    /// 可测分母的进度比值（0.0~1.0）；`None` = 本步骤**没有**可测分母。
    /// 只有真实可测的量（下载字节比）才允许写 `Some`：0.0 会同时被读成
    /// 「没开始」「没有分母」「刚起步」三种含义，按代码顺序编的阶段分数是假数。
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

// 安装/下载进度的语义（InstallKind / InstallFailure / 事件发射）唯一发射点在 `domain::install`。
// main.rs 只做组装（门禁 G3），不留第二处能构造事件形态的地方。




/// 无头输出：壳自更新基线（供 CI 冒烟与人工诊断）。
/// 副作用：写 identity.json + shell.log（验证落盘链路）。
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



// 超时预算（防「无超时网络请求把引导页永久卡住」）：
// 不变量：check 短超时（快速失败）、下载长超时（大包 + 慢网），外层再加 tokio 兜底
// （reqwest 的 request timeout 不保证覆盖 DNS 等阶段）。

/// 构造带超时的更新器。
/// 该超时是 reqwest 的**整个请求**超时：check 用短超时；下载必须用长超时，
///   否则大安装包会在传输中途被切断。
fn shell_updater(
    app: &tauri::AppHandle,
    timeout: std::time::Duration,
) -> Result<tauri_plugin_updater::Updater, String> {
    let mut builder = app.updater_builder().timeout(timeout);
    // 端点运行时覆盖：Tauri 配置里写死的 endpoints 是编译期常量，而不同网络环境下
    // CDN 可达性差异很大。用壳自持的镜像配置覆盖，使用户（或壳测速结果）能**不重新编译**切换更新源。
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
    // 启动里程碑日志（常开，落盘 <状态根>/shell/shell.log）：打开日志即可判定卡在
    // 「Rust setup 未执行」还是「前端 JS 未执行」。shell.log 超 1MB 自动滚动。
    macro_rules! bt {
        ($($a:tt)*) => {
            crate::update::log(&format!("[boot] {}", format!($($a)*)));
        };
    }
    bt!("main enter");
    // 状态根随启动落日志：schema 与三个实际路径在 shell.log 第一行就能看到
    // （原先这是一条诊断 IPC 命令，全仓零调用方 —— 日志才是本壳的观测通道）。
    bt!(
        "state-root schema={} root={} supervisor={} shell={}",
        env::STATE_ROOT_SCHEMA,
        env::state_root().display(),
        env::supervisor_dir().display(),
        env::shell_dir().display()
    );
    // 无头自检：镜像测速与选择（用户要求「镜像必须可见」的验证入口）。
    if std::env::args().any(|a| a == "--mirror-plan") {
        std::process::exit(domain::cli::cli_mirror_plan());
    }
    // 无头自检：环境探测（架构修复后的可诊断入口）。
    if std::env::args().any(|a| a == "--env-plan") {
        std::process::exit(domain::cli::cli_env_plan());
    }
    // 无头自检：守卫服务定义（P0 修复的功能验证入口，任何平台可用）。
    if std::env::args().any(|a| a == "--service-plan") {
        std::process::exit(domain::cli::cli_service_plan());
    }
    // 无头冒烟入口：--node-plan 仅打印环境探针 + 官方最新 LTS，不启动窗口。
    if std::env::args().any(|a| a == "--node-plan") {
        std::process::exit(domain::cli::cli_plan());
    }
    // 无头自检：**平台矩阵**（门禁 A4/G4）。目的：把「平台矩阵」从**文档承诺**变成
    //   **可执行断言** —— 文档说支持某能力但代码没实现，这一输出会在三平台 CI 上暴露；
    //   同时它是「平台适配层真的被接上」的活体证据。
    if std::env::args().any(|a| a == "--platform-matrix") {
        println!("{}", platform::matrix_text());
        std::process::exit(0);
    }
    // 无头自检：内核版本治理（包名/镜像/最新版本）——发布后冒烟验证，无需 GUI。
    if std::env::args().any(|a| a == "--core-plan") {
        println!("{}", core::plan_text());
        std::process::exit(0);
    }
    // 无头自检：壳自更新能力基线——发布后冒烟验证 + CI 门禁，无需 GUI。
    // 输出身份/安装形态/是否可自更新/护栏状态；同时**实际写一次** identity.json 与 shell.log，
    // 以验证落盘链路可用（这是「壳零日志、无法诊断」问题的结构性修复）。
    if std::env::args().any(|a| a == "--shell-update-plan") {
        println!("{}", shell_update_plan_text());
        std::process::exit(0);
    }
    // 运行时守卫入口：服务定义（systemd/launchd/schtasks）只指向 `<壳> --run-guard`。
    //   必须在 Tauri 初始化**之前**返回 —— 每次启动重新检测 node/guard 后 exec。
    if std::env::args().any(|a| a == "--run-guard") {
        std::process::exit(domain::cli::cli_run_guard());
    }
    // 无头看护入口：Windows 计划任务（DSH-Supervisor-Watchdog）每 5 分钟调用。
    //   判据与启动/面板同一实现（`guardctl::ready`），故必须在 Tauri 初始化之前返回。
    if std::env::args().any(|a| a == "--watchdog") {
        std::process::exit(domain::cli::cli_watchdog());
    }
    bt!("building app");
    tauri::Builder::default()
        // 单实例管控：同一 user 会话内只允许一个壳实例——重复启动第二实例时
        // 插件自动让新进程退出，回调里唤起既有主窗口（show+focus+导航面板），避免双壳/多壳并存。
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            domain::windowing::show_main(app);
        }))
        // 壳自更新插件：强制 minisign 验签；平台安装语义内部处理。
        // 未配置 pubkey 时插件仍可注册（check 会失败并返回错误，由引导页按「失败放行」处理）。
        .plugin(tauri_plugin_updater::Builder::new().build())
        // app.restart()：更新安装后重启进入新版本（旧进程装、新进程跑）。
        .plugin(tauri_plugin_process::init())
        .manage(Mutex::new(RunState::default()))
        .invoke_handler(tauri::generate_handler![commands::node_status, commands::core_status, commands::core_plan, commands::core_apply, commands::kernel_update_apply, commands::shell_bridge_contract, commands::guard_start, commands::guard_ready, commands::start_node_install, commands::finish_boot, commands::win_ctl, commands::shell_identity, commands::shell_update_check, commands::shell_update_apply, commands::shell_restart, commands::shell_set_phase, commands::mirror_status, commands::mirror_set, commands::node_latest, commands::mirror_warmup, commands::mirror_cached, commands::shell_panel_url])
        .setup(|app| {
            bt!("setup enter");
            // 状态根迁移（前向自愈）：把旧位置 ~/.dsh/{supervisor,shell} 的内容并入产品状态根。
            // 必须在任何读写状态之前执行；失败不阻断。
            env::migrate_legacy();
            // 托盘直发本地 API 的端口：显式 DSH_SUPERVISOR_TRAY_PORT 优先，否则**每次点击现取**。
            // 不做 setup 期快照：守卫因端口占用顺延过时，快照会把启动/停止/退出全打在没人监听的
            // 端口上，而 guardctl 一侧读的是当前值 —— 同一事实两套答案，退出握手就打错了对象。
            let port = || std::env::var("DSH_SUPERVISOR_TRAY_PORT")
                .ok().and_then(|p| p.parse().ok()).unwrap_or_else(env::current_api_port);
            let handle = app.handle().clone();

            // 壳身份初始化：写 <状态根>/shell/identity.json + shell.log（独立于 DSH）。
            // 必须尽量早执行：即使后续任一环节失败，也留下可诊断的落盘痕迹。
            bt!("init_identity...");
            let _ = update::init_identity(&app.package_info().version.to_string());
            bt!("init_identity done");

            // 无条件导出镜像契约（启动即导出；不依赖 latest_lts() 成功，失败只记日志）。
            crate::mirror::export_on_boot();

            // 环境判定：Node 缺失或低于最低标准（>=22.12）时由引导页安装；达标直接进面板。
            // 探测只触发（分离线程），不得阻塞 setup —— 窗口必须先出现。
            nodeprobe::start();
            // 镜像测速同样在引导即预热：registry 维度只读这份预热结果，只由引导页 JS 触发
            // 的话，任何一条不走 70-boot 的入口（直进面板/脚本页加载失败）都会让那一格永久问号。
            // WARMING 去重，前端那一枪仍在（B49），两边都打也不会测两遍。
            crate::mirror::warmup_async();
            {
                let h = handle.clone();
                std::thread::spawn(move || {
                    // 在飞探测最多等 45 秒（与引导页预算一致）；未完成则放弃本次回填，
                    // 下次 node_status 轮询仍会拿到结果。
                    let out = nodeprobe::status(std::time::Duration::from_secs(45));
                    if let Some(v) = out.version {
                        let st = h.state::<Mutex<RunState>>();
                        st.lock().unwrap_or_else(|e| e.into_inner()).installed = Some(v);
                    }
                });
            }
            // 单一引导流程：守卫的安装/升级/启动全部由引导页显式驱动
            // （core_plan、core_apply、guard_start、guard_ready），壳启动不并行拉起。
            std::thread::spawn(move || {
                if let Ok(c) = node::latest_lts() {
                    let v = c.version.clone();
                    let state = handle.state::<Mutex<RunState>>();
                    let mut s = state.lock().unwrap_or_else(|e| e.into_inner());
                    s.latest = Some(v.clone());
                    drop(s);
                    // 不发 env_status 广播：全仓**零监听**（bootstrap 只监听 shell:goto-panel /
                    //   shell:goto-bootstrap / guard_progress 与统一的 install_* 安装事件）。
                    //   它携带的 latest 由 node_status 轮询提供（单一事实源），再加监听反而
                    //   制造第二真源。s.latest 仍保留（node_status 从状态读取）。
                }
            });

            bt!("setup: building tray");
            // 托盘
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
                // 左键=显示窗口 / 右键=弹出菜单（Windows/Linux 惯例）。
                // 左键若也弹菜单，叠加下方 on_tray_icon_event 不区分按键，右键时菜单会被
                //   show_main() 抢焦点顶掉。注：上游文档明确 Linux 不支持该开关（菜单由桌面环境决定）。
                .show_menu_on_left_click(false)
                .on_menu_event(move |app, event| {
                    match event.id.as_ref() {
                        "show" => domain::windowing::show_main(app),
                        // 网络 I/O **必须离开 UI 线程**：托盘菜单事件由 UI 线程派发，而
                        //   post_local 最多阻塞 60 秒（TCP 连接 + 读写超时）；守卫挂起时
                        //   点击会把整个界面冻结。改为派发到独立线程：菜单立即响应，结果异步生效。
                        "start" => domain::localhttp::spawn_local_post(port(), "/lifecycle/dsh/start"),
                        "stop" => domain::localhttp::spawn_local_post(port(), "/lifecycle/dsh/stop"),
                        "restart" => domain::localhttp::spawn_local_post(port(), "/lifecycle/dsh/restart"),
                        // 退出管家 = 完全退出：通知守卫停止全部服务链，随后壳退出
                        "quit" => {
                            // 契约：请求内核停被管对象（等回执）-> 由所有者停止守卫 -> 壳退出。
                            // 同样离开 UI 线程：退出握手最坏可耗时约 70 秒（/session/stop 60s
                            //   + 轮询 10s）。若在 UI 线程做，窗口卡住会被误认为「程序关不掉」
                            //   而遭强杀 —— 那会跳过退出握手，留下未停的 DSH。
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
                    // 必须区分按键与状态：匹配 `Click { .. }`（任意键）会让**右键**也 show_main，
                    //   把刚要弹出的右键菜单顶掉/抢走焦点。只响应「左键 + 抬起」，
                    //   右键交由系统弹出 .menu() 设置的菜单。
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
                // 关闭窗口行为（读守卫 config.closeAction，系统级开关）：
                // 'exit' = 退出管家（通知守卫停止全部服务链 + 壳退出）；默认 'hide' = 隐藏至托盘常驻。
                if env::close_action() == "exit" {
                    // 必须离开 UI 线程（与托盘 quit 同一纪律）。
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
