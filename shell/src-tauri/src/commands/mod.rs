use std::sync::Mutex;

use tauri::Manager;

use crate::error::{ShellError, ShellResult};
use crate::RunState;

use crate::domain::install::{self, InstallKind};
use crate::domain::probes;

const SHELL_CHECK_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);
const SHELL_DOWNLOAD_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20 * 60);

#[tauri::command]
pub async fn node_status(app: tauri::AppHandle) -> serde_json::Value {
    let budget = std::time::Duration::from_millis(900);
    let out = match tauri::async_runtime::spawn_blocking(move || crate::nodeprobe::status(budget)).await {
        Ok(o) => o,
        Err(_) => crate::nodeprobe::partial(),
    };

        
    let node_for_deps = out.path.clone();
    let deps = match tauri::async_runtime::spawn_blocking(move || probes::dependents(node_for_deps)).await {
        Ok(s) => s,
        Err(_) => probes::Snapshot::aborted("依赖探测线程未返回（本轮按未知处理，不冒充结论）"),
    };
    let npm = &deps.npm;
    let mut o = {
        let state = app.state::<Mutex<RunState>>();
        let st = state.lock().unwrap_or_else(|e| e.into_inner());
        let installed = out.version.clone().or_else(|| st.installed.clone());
        let mut o = crate::log(&st);
        o["installed"] = serde_json::json!(installed);
        o["minOk"] = serde_json::json!(crate::node::meets_minimum(installed.as_deref()));
        o["minRequired"] = serde_json::json!(crate::node::MIN_NODE);
        if let Some(latest) = &st.latest {
            o["outdated"] = serde_json::json!(crate::node::outdated(installed.as_deref(), latest));
        }
                
        o["npmOk"] = match npm.ok() {
            Some(b) => serde_json::json!(b),
            None => serde_json::Value::Null,
        };
        o["npmVersion"] = serde_json::json!(npm.version());
        o["npmPath"] = serde_json::json!(npm.path());
        o["npmWhy"] = match &npm.why {
            Some(why) => serde_json::json!(why),
            None => serde_json::Value::Null,
        };
        o
    };
        
    if let (Some(p), Some(v), Some(u)) = (out.path.as_ref(), out.version.as_ref(), npm.usable.as_ref()) {
        if let Some(rt) = crate::runtime_contract::usable_runtime(p, v, u) {
            crate::runtime_contract::write(&rt);
        }
    }
    crate::shell_report::publish(&out, &deps);
    o["probing"] = serde_json::json!(!out.finished);
    o["probeError"] = match &out.error {
        Some(e) => serde_json::json!(e),
        None => serde_json::Value::Null,
    };
    o["nodePath"] = serde_json::json!(out.path.as_ref().map(|p| p.display().to_string()));
    o["elapsedMs"] = serde_json::json!(out.elapsed_ms);
    o["candidates"] = serde_json::json!(crate::nodeprobe::candidate_summary());
    o["stuck"] = match crate::nodeprobe::current_stuck() {
        Some((d, ms)) => serde_json::json!({ "on": d, "ms": ms }),
        None => serde_json::Value::Null,
    };
        
    let mut records: Vec<serde_json::Value> = out.records.iter().map(|r| r.json()).collect();
    records.extend(deps.records.iter().map(|r| r.json()));
    o["probes"] = serde_json::json!(records);
    o
}

#[tauri::command]
pub fn mirror_warmup() -> serde_json::Value {
    crate::mirror::warmup_async();
    serde_json::json!({ "ok": true })
}

#[tauri::command]
pub fn mirror_cached() -> serde_json::Value {
    match crate::mirror::cached() {
        Some(s) => serde_json::json!({
            "ready": true,
            "nodeBest": s.node_best,
            "nodeLatencyMs": s.node_latency_ms,
            "npmBest": s.npm_best,
            "npmLatencyMs": s.npm_latency_ms,
            "npmProbes": s.npm_probes.iter().map(|(src, ok, ms)| serde_json::json!({
                "source": src, "ok": ok, "latencyMs": ms
            })).collect::<Vec<_>>(),
            "at": s.at,
        }),
        None => serde_json::json!({ "ready": false }),
    }
}

#[tauri::command]
pub async fn node_latest() -> serde_json::Value {
    match tauri::async_runtime::spawn_blocking(crate::node::latest_lts).await {
        Ok(Ok(c)) => serde_json::json!({
            "ok": true,
            "version": c.version,
            "file": c.file,
            "mirror": c.source,
            "latencyMs": c.latency_ms,
            "probes": c.probes.iter().map(|(s, ok, ms)| serde_json::json!({
                "source": s, "ok": ok, "latencyMs": ms
            })).collect::<Vec<_>>(),
        }),
        Ok(Err(e)) => serde_json::json!({ "ok": false, "error": e }),
        Err(e) => serde_json::json!({ "ok": false, "error": e.to_string() }),
    }
}

#[tauri::command]
pub fn finish_boot(app: tauri::AppHandle) -> ShellResult<()> {
        
    crate::domain::guardctl::watch_panel(&app);
    crate::domain::windowing::go_panel(&app, false);
    Ok(())
}

#[tauri::command]
pub async fn system_node_ready() -> serde_json::Value {
    let found = match tauri::async_runtime::spawn_blocking(|| crate::env::probe_system_node()).await {
        Ok(v) => v,
        Err(_) => None,
    };
    let Some((path, version)) = found else {
        return serde_json::json!({
            "installed": serde_json::Value::Null,
            "minOk": false,
            "minRequired": crate::node::MIN_NODE,
            "npmOk": serde_json::Value::Null,
            "nodePath": serde_json::Value::Null,
        });
    };
    let min_ok = crate::node::meets_minimum(Some(&version));
    
    let usable = crate::runtime_contract::probe_npm_usable(&path, path.parent().unwrap_or(std::path::Path::new("")));
    let (npm_ok, npm_why) = match &usable {
        Ok(u) => (true, None),
        Err(e) => (false, Some(e.clone())),
    };
    
    
    {
        let why = npm_why.clone().unwrap_or_else(|| "无".to_string());
        crate::update::log(&format!(
            "system_node_ready 判定: installed={} nodePath={} npmOk={} npmWhy={}",
            version, path.display(), npm_ok, why
        ));
    }
    serde_json::json!({
        "installed": version,
        "minOk": min_ok,
        "minRequired": crate::node::MIN_NODE,
        "npmOk": npm_ok,
        "npmWhy": npm_why,
        "nodePath": path.display().to_string(),
    })
}

#[tauri::command]
pub fn boot_trace(line: String) {
    crate::update::log(&format!("[boot-trace] {}", line));
}

#[tauri::command]
pub fn start_node_install(state: tauri::State<Mutex<RunState>>, app: tauri::AppHandle) -> ShellResult<()> {
    let mut st = state.lock().unwrap_or_else(|e| e.into_inner());
    if st.busy { return Ok(()); }
    st.busy = true;
    st.error = None;
    st.progress = None;
    st.status = "准备安装 Node.js LTS…".into();
    st.logs.clear();
    let handle = app.clone();
    std::thread::spawn(move || {
        let out = install::run_install(&handle);
        let state = handle.state::<Mutex<RunState>>();
        let mut s = state.lock().unwrap_or_else(|e| e.into_inner());
        s.busy = false;
        match out {
            Ok(rt) => {
                s.installed = Some(rt.version.clone());
                s.progress = Some(1.0);
                s.status = format!(
                    "运行环境就绪（Node {} · npm {}），正在启动守卫…",
                    rt.version,
                    rt.npm_version_label()
                );
                s.logs.push(format!("安装完成: {} @ {}", rt.version, rt.node.display()));
                                
                probes::invalidate_all();
                drop(s);
                                
                install::done(&handle, InstallKind::Node, serde_json::json!(rt.version));
                install::done(&handle, InstallKind::Npm, serde_json::json!(rt.npm_version));
            }
            Err(f) => {
                s.error = Some(f.message.clone());
                s.status = "环境就绪前置失败".into();
                s.logs.push(format!("失败({}): {}", f.kind.as_str(), f.message));
                drop(s);
                install::fail(&handle, f.kind, &f.message);
            }
        }
    });
    drop(st);
    Ok(())
}

#[tauri::command]
pub async fn core_status(app: tauri::AppHandle) -> serde_json::Value {
    let pkg = crate::core::package_name().unwrap_or_else(|_| "@lob-ox/core-<platform>".into());
    let located = tauri::async_runtime::spawn_blocking(move || {
        let a = app.clone();
        crate::domain::coreloc::locate_core_with_version(&a)
    })
    .await
    .ok()
    .flatten();
    let (installed, version, path) = match located {
        Some((p, v)) => (true, v, Some(p.display().to_string())),
        None => (false, None, None),
    };
    serde_json::json!({
        "installed": installed,
        "version": version,
        "path": path,
        "package": pkg,
        "hint": format!("npm i -g {}", pkg),
    })
}

#[tauri::command]
pub async fn core_plan(app: tauri::AppHandle) -> ShellResult<serde_json::Value> {
    let installed = tauri::async_runtime::spawn_blocking(move || {
        let a = app.clone();
        crate::domain::coreloc::locate_core(&a).and_then(|b| crate::core::installed_version(&b))
    })
    .await
    .ok()
    .flatten();
    let pkg = crate::core::package_name()?;
    let latest = tauri::async_runtime::spawn_blocking(move || crate::core::latest_pick(&pkg))
        .await.map_err(|e| ShellError::ipc(e.to_string()))?;
    Ok(crate::core::build_plan(installed, latest))
}

#[tauri::command]
pub async fn core_apply(app: tauri::AppHandle) -> ShellResult<serde_json::Value> {
    core_apply_inner(app).await
}

fn fetch_kernel_tgz(
    app: &tauri::AppHandle,
    pkg: &str,
    version: &str,
    origin: &str,
) -> Result<std::path::PathBuf, String> {
    let dist = crate::core::dist_from(pkg, version, origin)?;
    install::kernel_fetch(app, version, origin, dist.size, dist.sha512.is_some());
    let dst = crate::core::dist_cache_path(pkg, version);
    let a = app.clone();
    let on_bytes = move |done: u64, total: Option<u64>| install::download(&a, InstallKind::Kernel, done, total);
    let (bytes, verified) = crate::core::fetch_dist(&dist, &dst, &on_bytes)?;
    install::kernel_fetched(app, bytes, verified);
    Ok(dst)
}

async fn core_apply_inner(app: tauri::AppHandle) -> ShellResult<serde_json::Value> {
    let _ = crate::runtime_contract::ensure();
    let pkg = crate::core::package_name()?;
    let prefix = crate::domain::coreloc::locate_core(&app).and_then(|b| crate::core::global_prefix_for(&b));
    let origins = crate::core::registry_origins();
        
    let target = {
        let p = pkg.clone();
        let r = tauri::async_runtime::spawn_blocking(move || crate::core::latest_version(&p))
            .await.map_err(|e| ShellError::ipc(e.to_string()))?;
        match r {
            Ok((v, _)) => v,
            Err(e) => return Ok(serde_json::json!({"ok": false, "stage": "resolve", "error": e})),
        }
    };
    let origins_for_report = origins.clone();
    let pkg2 = pkg.clone();
    let target2 = target.clone();
    let pref = prefix.clone();
    let app2 = app.clone();
    let res = tauri::async_runtime::spawn_blocking(move || {
                
        let deadline = std::time::Instant::now()
            + std::time::Duration::from_millis(crate::bridge::KERNEL_UPDATE_BUDGET_MS);
        let total = origins.len();
        let mut tried = 0usize;
        let mut last = String::from("无可用镜像");
        install::kernel_begin(&app2, &target2, total);
        for o in &origins {
            if std::time::Instant::now() >= deadline {
                last = format!("总预算耗尽：已尝试 {}/{} 个源；最后错误: {}", tried, total, last);
                break;
            }
            tried += 1;
            install::kernel_source(&app2, tried, total, o);
            let beat_app = app2.clone();
            let beat = |live: &crate::bounded::Live| {
                install::push(
                    &beat_app,
                    InstallKind::Kernel,
                    install::npm_heartbeat(live.elapsed, live.lines, &live.last_line),
                    None,
                );
            };
            let beat_ref = Some(&beat as &dyn Fn(&crate::bounded::Live));
                        
            let local = match fetch_kernel_tgz(&app2, &pkg2, &target2, o) {
                Ok(p) => Some(p),
                Err(why) => {
                    install::kernel_direct(&app2, o, &why);
                    None
                }
            };
            let out = match &local {
                Some(tgz) => crate::core::install_local(tgz, pref.as_deref(), Some(o.as_str()), beat_ref),
                None => crate::core::install_version(&pkg2, &target2, pref.as_deref(), Some(o.as_str()), beat_ref),
            };
            if let Some(tgz) = &local {
                let _ = std::fs::remove_file(tgz);
            }
            match out {
                Ok(out) => return Ok::<(String, String), String>((o.clone(), out)),
                Err(e) => last = e,
            }
        }
        Err(last)
    }).await.map_err(|e| ShellError::ipc(e.to_string()))?;
    Ok(match res {
                
        Ok((origin, out)) => {
            let prefix_used = prefix.clone().or_else(crate::core::npm_global_prefix);
            match crate::domain::coreloc::locate_core_at_version(&app, &target, prefix_used.as_deref()) {
                Some(bin) => {
                    crate::core_contract::write(&crate::core_contract::InstalledCore {
                        bin: bin.clone(),
                        prefix: prefix_used.clone(),
                        version: target.clone(),
                        source: origin.clone(),
                    });
                    serde_json::json!({
                        "ok": true, "version": target, "origin": origin, "output": out,
                        "coreBin": bin.display().to_string(),
                        "prefix": prefix_used.map(|p| p.display().to_string()),
                    })
                }
                None => serde_json::json!({
                    "ok": false, "stage": "record",
                    "version": target, "origin": origin,
                    "error": "内核已安装但定位不到目标版本（安装前缀不一致）——已拒绝继续，请反馈此诊断",
                    "prefix": prefix_used.as_ref().map(|p| p.display().to_string()),
                }),
            }
        }
        Err(e) => serde_json::json!({
            "ok": false, "version": target, "error": e,
            "prefix": prefix.as_ref().map(|p| p.display().to_string()),

            "originsTried": origins_for_report,
            "prefixIsNodeDir": prefix.as_ref().map(|p| crate::core::is_node_install_prefix(p)),
        }),
    })
}

#[tauri::command]
pub async fn kernel_update_apply(app: tauri::AppHandle) -> ShellResult<serde_json::Value> {
    let install_out = core_apply_inner(app.clone()).await?;
    if install_out.get("ok").and_then(|v| v.as_bool()) != Some(true) {
        return Ok(serde_json::json!({ "ok": false, "stage": "install", "detail": install_out }));
    }
        
    let restart = tauri::async_runtime::spawn_blocking(move || -> Result<(bool, Option<String>), crate::domain::guardctl::LaunchError> {
        let port = crate::env::current_api_port();
        let stop_error = crate::platform::service().stop().err();
        let mut stopped = false;
        for _ in 0..60 {
            if !crate::domain::guardctl::port_open(port) { stopped = true; break; }
            std::thread::sleep(std::time::Duration::from_millis(250));
        }
        crate::domain::guardctl::ensure_guard(&app)?;
        Ok((stopped, stop_error))
    }).await;
    match restart {
        Ok(Ok((stopped, stop_error))) => Ok(serde_json::json!({
            "ok": true, "stage": "done",
            "version": install_out.get("version").cloned().unwrap_or(serde_json::Value::Null),
            "origin": install_out.get("origin").cloned().unwrap_or(serde_json::Value::Null),
            "stopped": stopped,
            "restartUncertain": !stopped,
            "stopError": stop_error,
        })),
        Ok(Err(e)) => Ok(serde_json::json!({ "ok": false, "stage": "restart", "code": e.code, "error": e.message, "detail": install_out })),
        Err(e) => Ok(serde_json::json!({ "ok": false, "stage": "restart", "error": e.to_string(), "detail": install_out })),
    }
}

#[tauri::command]
pub fn shell_bridge_contract() -> serde_json::Value {
    serde_json::json!({
        "v": crate::bridge::KERNEL_UPDATE_PROTOCOL_VERSION,
        "cmd": crate::bridge::CMD_KERNEL_UPDATE_APPLY,
        "kernelKind": InstallKind::Kernel.as_str(),
        "maxWaitMs": crate::bridge::KERNEL_UPDATE_MAX_WAIT_MS,
        "types": {
            "request": crate::bridge::MSG_KERNEL_UPDATE_REQUEST,
            "result": crate::bridge::MSG_KERNEL_UPDATE_RESULT,
            "progress": crate::bridge::MSG_KERNEL_UPDATE_PROGRESS,
        }
    })
}

#[tauri::command]
pub async fn guard_start(app: tauri::AppHandle) -> ShellResult<serde_json::Value> {
    const GUARD_TOTAL_BUDGET: std::time::Duration = std::time::Duration::from_secs(180);
    let a = app.clone();
    let task = tauri::async_runtime::spawn_blocking(move || crate::domain::guardctl::ensure_guard(&a));
    let r = match tokio::time::timeout(GUARD_TOTAL_BUDGET, task).await {
        Ok(Ok(inner)) => inner,
        Ok(Err(e)) => Err(crate::domain::guardctl::LaunchError::new(
            "JOIN_ERROR",
            format!("守卫启动任务异常: {}", e),
        )),
        Err(_) => Err(crate::domain::guardctl::LaunchError::new(
            "READY_TIMEOUT",
            format!(
                "守卫启动超时（{} 秒未完成）。可能原因：服务管理器无响应，或守卫进程无法启动。请用 lobox-shell --service-plan 查看服务定义状态。",
                GUARD_TOTAL_BUDGET.as_secs()
            ),
        )),
    };
    Ok(match r {
        Ok(()) => serde_json::json!({"ok": true}),
                
        Err(e) => serde_json::json!({"ok": false, "code": e.code, "error": e.message}),
    })
}

#[tauri::command]
pub async fn guard_ready() -> serde_json::Value {
    tauri::async_runtime::spawn_blocking(|| {
        let port = crate::env::current_api_port();
        match crate::domain::guardctl::ready(port, GUARD_READY_PROBE_TIMEOUT) {
            crate::domain::guardctl::Readiness::Ready => serde_json::json!({"ready": true, "port": port}),
            crate::domain::guardctl::Readiness::PortClosed => serde_json::json!({"ready": false, "reason": "tcp", "port": port}),
            crate::domain::guardctl::Readiness::Http(code) => serde_json::json!({"ready": false, "reason": "http", "status": code, "port": port}),
            crate::domain::guardctl::Readiness::NoHttpResponse => serde_json::json!({"ready": false, "reason": "http", "port": port}),
        }
    })
    .await
    .unwrap_or_else(|_| serde_json::json!({"ready": false, "reason": "probe-panic"}))
}

const GUARD_READY_PROBE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(3);

#[tauri::command]
pub fn win_ctl(app: tauri::AppHandle, action: String) -> ShellResult<()> {
    let win = app.get_webview_window("main").ok_or("主窗口不存在")?;
    match action.as_str() {
        "minimize" => win.minimize().map_err(|e| ShellError::ipc(e.to_string())),
        "toggle-maximize" => {
            if win.is_maximized().unwrap_or(false) {
                win.unmaximize().map_err(|e| ShellError::ipc(e.to_string()))
            } else {
                win.maximize().map_err(|e| ShellError::ipc(e.to_string()))
            }
        }
        "maximize" => win.maximize().map_err(|e| ShellError::ipc(e.to_string())),
        "unmaximize" => win.unmaximize().map_err(|e| ShellError::ipc(e.to_string())),
        "hide" => {
            let _ = win.hide();
            Ok(())
        }
        "drag" => {
                        
            win.start_dragging().map_err(|e| ShellError::ipc(e.to_string()))
        }
        _ => Err(format!("不支持的窗口动作: {}（minimize/toggle-maximize/maximize/unmaximize/hide/drag）", action).into()),
    }
}

#[tauri::command]
pub fn shell_panel_url() -> serde_json::Value {
    let (url, serving) = crate::domain::guardctl::panel_view();
    crate::update::log(&format!(
        "壳框架就绪（主帧导航完成），面板 URL: {} · 服役判定={}",
        url, serving
    ));
    serde_json::json!({ "url": url, "serving": serving })
}

#[tauri::command]
pub fn shell_identity(app: tauri::AppHandle) -> serde_json::Value {
    let v = app.package_info().version.to_string();
    let mut id = crate::update::identity_snapshot();
    if id.get("version").is_none() {
        id = crate::update::init_identity(&v);
    }
    id
}

#[tauri::command]
pub fn shell_set_phase(phase: String) {
    crate::update::set_phase(&phase);
}

#[tauri::command]
pub fn pm_status(app: tauri::AppHandle) -> serde_json::Value {
    let pm = app.state::<std::sync::Arc<crate::process_manager::ProcessManager>>();
    let states = pm.states.lock().unwrap();
    let ports = pm.ports.lock().unwrap();
    let workloads: serde_json::Value = states
        .iter()
        .map(|(id, st)| {
            serde_json::json!({
                "id": id,
                "phase": format!("{:?}", st.phase),
                "desired": format!("{:?}", st.desired),
                "restart_backoff": format!("{:?}", st.restart_backoff),
                "fail_count": st.fail_count,
                "restart_burst": st.restart_burst,
                "halted": matches!(st.restart_backoff, crate::process_manager::state_machine::RestartBackoff::Tripped),
                "last_will": st.last_will.as_ref().map(|w| serde_json::json!({"code": w.code, "signal": w.signal})),
            })
        })
        .collect();
    serde_json::json!({
        "workloads": workloads,
        "ports": ports.to_json(),
    })
}

#[tauri::command]
pub async fn mirror_status() -> ShellResult<serde_json::Value> {
    let m = crate::mirror::load();
    let node_probes = tauri::async_runtime::spawn_blocking(|| {
        let m = crate::mirror::load();
        crate::mirror::probe_all(&m.node, "index.json")
    })
    .await
    .map_err(|e| ShellError::ipc(e.to_string()))?;
    let npm_probes = tauri::async_runtime::spawn_blocking(|| {
        let m = crate::mirror::load();
        crate::mirror::probe_all(&m.npm, "")
    })
    .await
    .map_err(|e| ShellError::ipc(e.to_string()))?;
        
    crate::mirror::record_npm_measurements(&npm_probes);
    let fmt = |v: Vec<crate::mirror::Probe>| {
        v.into_iter()
            .map(|p| serde_json::json!({ "source": p.source, "ok": p.ok, "latencyMs": p.latency_ms }))
            .collect::<Vec<_>>()
    };
    Ok(serde_json::json!({
        "ok": true,
        "node": m.node,
        "npm": m.npm,
        "shell": m.shell,
        "selectedNode": m.selected_node,
        "nodeProbes": fmt(node_probes),
        "npmProbes": fmt(npm_probes),
    }))
}

#[tauri::command]
pub fn mirror_set(kind: String, urls: Vec<String>) -> ShellResult<serde_json::Value> {
    let mut m = crate::mirror::load();
    let mut list: Vec<String> = Vec::new();
    for raw in &urls {
        if raw.trim().is_empty() {
            continue;
        }
        let base = crate::mirror::registry_base(raw)?;
        if !list.iter().any(|x| x == &base) {
            list.push(base);
        }
    }
    if list.is_empty() {
        return Err("镜像列表不能为空".into());
    }
    match kind.as_str() {
        "node" => m.node = list.clone(),
        "npm" => m.npm = list.clone(),
        "shell" => m.shell = list.clone(),
        _ => return Err(format!("未知镜像类型: {}（支持 node / npm / shell）", kind).into()),
    }
    if kind == "npm" {
        m.npm_measurements.clear();
    }
    crate::mirror::save(&m)?;
    if kind == "npm" {
        let _ = crate::mirror::export_to_kernel(&m);
    }
    crate::update::log(&format!("镜像配置已更新 {}: {}", kind, list.join(", ")));
    Ok(serde_json::json!({ "ok": true, "kind": kind, "urls": list }))
}

fn shell_plan(
    cur: &str,
    latest: Option<String>,
    available: bool,
    err: Option<String>,
    notes: String,
    date: String,
) -> serde_json::Value {
    let mut extra = serde_json::Map::new();
    extra.insert("ok".into(), serde_json::json!(err.is_none()));
    extra.insert("current".into(), serde_json::json!(cur));
    extra.insert("notes".into(), serde_json::json!(notes));
    extra.insert("date".into(), serde_json::json!(date));
    crate::update_plan::unified("shell", Some(cur.to_string()), latest, available, None, err, extra)
}

#[tauri::command]
pub async fn shell_update_check(app: tauri::AppHandle) -> ShellResult<serde_json::Value> {
    let cur = app.package_info().version.to_string();
    crate::update::set_phase("shell-update-check");
    let updater = match crate::shell_updater(&app, SHELL_CHECK_TIMEOUT) {
        Ok(u) => u,
        Err(msg) => {
            crate::update::log(&format!("桌面更新检查失败：{}", msg));
            return Ok(shell_plan(&cur, None, false, Some(msg), String::new(), String::new()));
        }
    };
        
    let checked = tokio::time::timeout(
        SHELL_CHECK_TIMEOUT + std::time::Duration::from_secs(5),
        updater.check(),
    )
    .await;
    match checked {
        Err(_) => {
            let msg = format!("检查超时（{} 秒无响应，可能网络不可达）", SHELL_CHECK_TIMEOUT.as_secs());
            crate::update::log("桌面更新检查超时（网络不可达？）");
            Ok(shell_plan(&cur, None, false, Some(msg), String::new(), String::new()))
        }
        Ok(Ok(Some(u))) => {
            let latest = u.version.clone();
            crate::update::log(&format!("桌面更新发现新版本 {}（当前 {}）", latest, cur));
            Ok(shell_plan(
                &cur,
                Some(latest),
                true,
                None,
                u.body.clone().unwrap_or_default(),
                u.date.map(|d| d.to_string()).unwrap_or_default(),
            ))
        }
        Ok(Ok(None)) => {
            crate::update::log(&format!("桌面更新已是最新（{}）", cur));
            Ok(shell_plan(&cur, None, false, None, String::new(), String::new()))
        }
        Ok(Err(e)) => {
            let msg = format!("{}", e);
            crate::update::log(&format!("桌面更新检查失败：{}", msg));
            Ok(shell_plan(&cur, None, false, Some(msg), String::new(), String::new()))
        }
    }
}

fn worth_next_source(err: &tauri_plugin_updater::Error) -> bool {
    use tauri_plugin_updater::Error as E;
    matches!(err, E::Network(_) | E::Reqwest(_) | E::Io(_))
}

#[tauri::command]
pub async fn shell_update_apply(app: tauri::AppHandle) -> ShellResult<serde_json::Value> {
    crate::update::set_phase("shell-update-download");
    let updater = crate::shell_updater(&app, SHELL_DOWNLOAD_TIMEOUT)?;
    let found = match tokio::time::timeout(SHELL_CHECK_TIMEOUT, updater.check()).await {
        Err(_) => {
            return Ok(serde_json::json!({ "ok": false, "error": "检查超时（可能网络不可达）" }));
        }
        Ok(Err(e)) => {
            return Ok(serde_json::json!({ "ok": false, "error": format!("检查失败: {}", e) }));
        }
        Ok(Ok(f)) => f,
    };
    let Some(u) = found else {
        return Ok(serde_json::json!({ "ok": true, "upToDate": true }));
    };
    let target = u.version.clone();

    let candidates = crate::mirror::artifact_candidates(&u.download_url, &u.version);
    crate::update::log(&format!("桌面更新开始下载 {}（{} 个候选源）", target, candidates.len()));
    let mut failures: Vec<String> = Vec::new();
    let mut downloaded: Option<Vec<u8>> = None;
    for (idx, url) in candidates.iter().enumerate() {
        let host = url.host_str().unwrap_or("?").to_string();
        let mut candidate = u.clone();
        candidate.download_url = url.clone();
        let mut got: u64 = 0;
        let dl = tokio::time::timeout(
            SHELL_DOWNLOAD_TIMEOUT,
            candidate.download(
                |chunk, total| {
                    got += chunk as u64;
                                        
                    install::download(&app, InstallKind::Shell, got, total.map(|t| t as u64));
                },
                || {},
            ),
        )
        .await;
        match dl {
            Err(_) => failures.push(format!(
                "{}：下载超时（{} 分钟未完成）",
                host,
                SHELL_DOWNLOAD_TIMEOUT.as_secs() / 60
            )),
            Ok(Err(e)) => {
                if !worth_next_source(&e) {
                    let msg = format!("下载失败: {}", e);
                    crate::update::log(&format!("桌面更新{}（源 {}）", msg, host));
                    return Ok(serde_json::json!({ "ok": false, "error": msg }));
                }
                failures.push(format!("{}：{}", host, e));
            }
            Ok(Ok(bytes)) => {
                if !failures.is_empty() {
                    crate::update::log(&format!("桌面更新改由 {} 取回（前面 {} 个源失败）", host, failures.len()));
                }
                downloaded = Some(bytes);
                break;
            }
        }
        if idx + 1 < candidates.len() {
            crate::update::log(&format!("桌面更新换下一个源：{}", failures.last().unwrap_or(&String::new())));
        }
    }
    let Some(bytes) = downloaded else {
        let msg = format!("下载失败（{} 个源都没取到安装包）：{}", candidates.len(), failures.join("；"));
        crate::update::log(&format!("桌面更新{}", msg));
        return Ok(serde_json::json!({ "ok": false, "error": msg }));
    };

    let downloaded_bytes = bytes.len() as u64;
    install::push(
        &app,
        InstallKind::Shell,
        format!("下载完成（{:.1} MB）· 正在安装…", downloaded_bytes as f64 / 1048576.0),
        Some(1.0),
    );
    crate::update::log(&format!("桌面更新下载完成（{} 字节），开始安装 {}", downloaded_bytes, target));

        
    if let Err(e) = u.install(bytes) {
        let msg = format!("安装失败: {}", e);
        crate::update::log(&format!("桌面更新{}", msg));
        return Ok(serde_json::json!({ "ok": false, "error": msg }));
    }
    crate::update::log(&format!("桌面更新安装完成 {}", target));
    Ok(serde_json::json!({ "ok": true, "installed": target }))
}

#[tauri::command]
pub fn shell_restart(app: tauri::AppHandle) {
    crate::update::set_phase("restarting");
    crate::update::log("桌面更新重启以应用新版本");
    app.restart();
}

#[cfg(test)]
mod tests {
    use super::worth_next_source;
    use tauri_plugin_updater::Error as E;

        
    #[test]
    fn only_byte_shortfall_advances_to_next_source() {
        assert!(worth_next_source(&E::Network(
            "Download request failed with status: 403 Forbidden".to_string()
        )));
        assert!(worth_next_source(&E::Io(std::io::Error::new(
            std::io::ErrorKind::UnexpectedEof,
            "stream closed"
        ))));
        assert!(!worth_next_source(&E::SignatureUtf8("not-a-signature".to_string())));
        assert!(!worth_next_source(&E::ReleaseNotFound));
    }
}
