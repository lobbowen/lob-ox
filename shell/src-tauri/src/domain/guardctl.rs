//! 守卫的启停与就绪判定（生命周期所有权的调用方）。铁律：壳**自己**是守卫生命周期的所有者 ——
//! 服务管理器是产品自身的监控器（见 `platform::service`），进程由本产品持有，**不向**
//! systemd / launchd / 任务计划程序投递任何东西，也不存在「用系统通道投递」的选项。
//! 阶段序列 P0 契约 -> P1 对齐 -> P3 定位 -> P4 登记 -> P5 启动 -> P6 就绪；P1 是 P5 的前置（磁盘内核必须等于线上最新，否则拒绝启动）。所有等待都有上限，退出也要能在受管对象无响应时走完。

use std::net::{TcpStream, ToSocketAddrs};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use tauri::{Emitter, Manager};

static EXITING: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Clone)]
pub(crate) struct LaunchError {
    pub code: &'static str,
    pub message: String,
}

impl LaunchError {
    pub(crate) fn new(code: &'static str, message: impl Into<String>) -> Self {
        LaunchError { code, message: message.into() }
    }
}




/// `--run-guard` 的本地检测（不触网）：解析可运行的 node + 守卫（取本地最高版本）。服务定义只指向稳定入口，故每次启动重新检测，node 迁移（nvm/volta/fnm）与内核升级后自动适配；线上对齐（P1）仍由壳在创建/启动服务前把关，此处只做本地解析，离线也能启动。
pub fn resolve_local(resource_dir: Option<std::path::PathBuf>) -> Option<(crate::runtime_contract::NodeRuntime, std::path::PathBuf)> {
    let rt = crate::runtime_contract::ensure()?;
    let guard = crate::domain::coreloc::pick_highest(
        crate::domain::coreloc::locate_core_candidates(resource_dir),
    )?;
    Some((rt, guard))
}

// R7-架构：停机不再走「/session/stop 握手 + 轮询 sessionState + service().stop()」三段式。
// 那套是守卫所有权语义：守卫是「唯一监管者」，要等它自己拆完服务链再让外部停。
// 进程管理时代壳直接持有进程句柄（adopt_spawned），停机就是停进程表里的每个对象，
// 没有握手、没有让出端口的等待预算、没有 GUARD_STOP_FAILED 这条路径。
pub(crate) fn shutdown_all(_port: u16) {
    EXITING.store(true, Ordering::SeqCst);
    let pm = crate::process_manager::handle();
    let ids: Vec<String> = {
        let s = pm.states.lock().unwrap_or_else(|e| e.into_inner());
        s.keys().cloned().collect()
    };
    for id in ids {
        // 先置期望停机（自愈节拍据此不再重拉），再按 pid 直接终止。
        pm.set_desired(&id, crate::process_manager::state_machine::Desired::Stopped);
        let pid = {
            let s = pm.states.lock().unwrap_or_else(|e| e.into_inner());
            s.get(&id).and_then(|st| st.pid)
        };
        match pid {
            Some(p) => {
                crate::update::log(&format!("[shell] 停止 {} (pid={})", id, p));
                if !crate::bounded::kill_tree_pid(p) {
                    crate::update::log(&format!("[shell] 停止 {} (pid={}) 失败", id, p));
                }
            }
            None => {
                // 壳不持有句柄（内核自报路径）：退回服务通道停一次。
                let _ = crate::platform::service().stop();
            }
        }
    }
    crate::update::log("[shell] 进程表已全部停机");
}

/// 服务管理器路径（P4 建立定义 -> P5 请求启动）的阶段产物。不变量由结构强制：`started` 只可能在 `defined` 为 `Ok` 时才是 `Some` —— 定义失败时那条出边是关闭的。丢掉 `ensure_defined` 的错误再无条件 `start()`，报错就只剩「/Run 失败（退出码 1）」，真实失败点可能在更早的 P4。
/// 内核进程登记表项：把「内核」作为最高优先级负载收进机箱进程表。
/// 这是进程所有权归壳的体现 —— 表里没有内核，自愈就无从谈起。
fn core_desc() -> crate::process_manager::state_machine::WorkloadDesc {
    crate::process_manager::state_machine::WorkloadDesc {
        id: "core".to_string(),
        spawn_cmd: Vec::new(),
        priority: crate::process_manager::state_machine::Priority::Core,
        env: Vec::new(),
    }
}

/// 内核已在服役（壳未持有其句柄，例如 exec 替换或已存在实例）：登记为 running，pid 未知。
fn register_core(app: &tauri::AppHandle) {
    if let Some(pm) = app.try_state::<std::sync::Arc<crate::process_manager::ProcessManager>>() {
        pm.register_workload(core_desc());
        pm.on_phase("core", crate::process_manager::state_machine::Phase::Running);
        pm.set_desired("core", crate::process_manager::state_machine::Desired::Running);
    }
}

/// 壳自持路径：壳 spawn 出内核进程，把 pid 一并登记（进程所有权归壳）。
fn register_core_spawned(app: &tauri::AppHandle, pid: u32) {
    if let Some(pm) = app.try_state::<std::sync::Arc<crate::process_manager::ProcessManager>>() {
        pm.adopt_spawned(core_desc(), pid);
        pm.set_desired("core", crate::process_manager::state_machine::Desired::Running);
    }
}

/// 启动路径的内核定位（不触网）：版本校对已前移到引导页的 stepCorePlan，
/// 启动只负责把「本地已装内核」定位出来并拉起 —— 联网比对版本属业务判定，壳不在此越界。
fn resolve_local_kernel(
    app: &tauri::AppHandle,
) -> Result<(std::path::PathBuf, String), String> {
    let resource_dir = app.path().resource_dir().ok();
    if let Some(c) = crate::core_contract::read() {
        let bin = crate::domain::coreloc::normalize_guard(c.bin, None);
        if bin.is_file() {
            return Ok((bin, c.version));
        }
    }
    let guard = crate::domain::coreloc::pick_highest(
        crate::domain::coreloc::locate_core_candidates(resource_dir),
    )
    .ok_or_else(|| "本地未找到任何已安装内核".to_string())?;
    let version = crate::core::installed_version(&guard)
        .unwrap_or_else(|| "unknown".to_string());
    let prefix = crate::core::global_prefix_for(&guard);
    crate::core_contract::write(&crate::core_contract::InstalledCore {
        bin: guard.clone(),
        prefix,
        version: version.clone(),
        source: "local-adopted".into(),
    });
    Ok((guard, version))
}

// R7-架构：启动判据从「端口上有没有人 + 守卫会话语义」改为「进程表里有没有我持有的内核」。
// 原逻辑三段：port_open → serving_state（/healthz + /session/status）→ 停等让出端口。
// 那整套是守卫所有权语义（守卫是唯一监管者，壳要等它让端口），也正是打死进程管理路径的地方：
// 端口被外部占用时壳会先花 15 秒等它让，再报 GUARD_STOP_FAILED，而进程管理本可直接认领或重启。
// 现在唯一判据是进程表：表里有 running 的内核 → 已在服役；否则走正常启动序列。
pub(crate) fn ensure_core(app: &tauri::AppHandle) -> Result<(), LaunchError> {
    let step = |s: &str| {
        let _ = app.emit("core_progress", serde_json::json!({ "status": s }));
        crate::update::log(s);
    };

    // 进程表判据：壳自己 spawn 并持有句柄的内核（pid 已知）才算在服役。
    // 不探端口——端口被别的进程占是端口层的事，归 PortAuthority + heal 处理，
    // 不该在启动路径上阻塞 15 秒再失败。
    let pm = crate::process_manager::handle();
    let already = {
        let s = pm.states.lock().unwrap_or_else(|e| e.into_inner());
        s.values().any(|st| st.pid.is_some()
            && st.phase == crate::process_manager::state_machine::Phase::Running)
    };
    if already {
        step("内核已在服役（进程表登记）· 跳过启动");
        register_core(app);
        return Ok(());
    }

    let rt = crate::runtime_contract::ensure().ok_or_else(|| {
        LaunchError::new("RUNTIME_MISSING", "Node 运行环境未就绪：无法解析 node/npm（请先完成环境准备）")
    })?;

    step("正在校验内核与线上版本对齐…");
    let (guard, version) = match resolve_local_kernel(app) {
        Ok(v) => v,
        Err(e) => {
            return Err(LaunchError::new(
                "KERNEL_MISSING",
                format!("未找到已安装的内核（请先在引导页完成内核安装/更新）：{}", e),
            ));
        }
    };
    step(&format!("内核已定位 v{}", version));
    let spec = crate::platform::LaunchSpec::from_runtime(&rt, guard)
        .map_err(|e| LaunchError::new("LAUNCH_SPEC_FAILED", e))?;
    ensure_started(app, &spec, &step)
}

pub(crate) fn ensure_started(
    app: &tauri::AppHandle,
    spec: &crate::platform::LaunchSpec,
    step: &dyn Fn(&str),
) -> Result<(), LaunchError> {
        // 开机自启登记（唯一用途）：让 OS 在登录时把壳拉起来，拉起内核本身不借 OS 通道。
    if let Err(e) = crate::platform::service().ensure_defined(spec) {
        crate::update::log(&format!("开机自启登记失败（不阻断启动）: {}", e));
    } else {
        crate::update::log("开机自启登记已就位");
    }

        // 正式路径：壳自己拉起内核并持有进程（进程所有权归壳，自愈由机箱进程表按优先级驱动）。
    step("正在拉起内核…");
    match crate::platform::service().spawn_daemon(spec) {
        Ok(mut child) => {
            let pid = child.id();
            crate::update::log(&format!("已拉起内核 pid={}", pid));
            let (verdict, exited) = await_daemon(DAEMON_READY_BUDGET, &mut child);
            if verdict == Readiness::Ready {
                register_core_spawned(app, pid);
                return Ok(());
            }
            Err(LaunchError::new(
                "READY_TIMEOUT",
                format!(
                    "内核启动失败（{}）；进程 pid={}{}，其输出见 {}\n内核输出末段：{}",
                    verdict.describe(),
                    pid,
                    match exited {
                        Some(code) => format!("已退出（{}）", crate::bounded::exit_code_label(Some(code))),
                        None => "仍在运行".to_string(),
                    },
                    crate::update::guard_log_path().display(),
                    guard_log_tail()
                ),
            ))
        }
        Err(e) => Err(LaunchError::new(
            "KERNEL_SPAWN_FAILED",
            format!("内核拉起失败：{}", e),
        )),
    }
}

/// 兜底直拉后的等待：就绪判据与 [`await_ready`] 同源，但子进程非零退出即早停 —— 一个已经退出的进程不会再变绿，让它跑满 60 秒就是把「拉起即失败」说成「启动超时」。退出码 0 不算失败：Windows 上稳定入口 `<壳> --run-guard` 是先 detach 出 node 再退出的，它退了不代表守卫退了。
fn await_daemon(
    budget: std::time::Duration,
    child: &mut std::process::Child,
) -> (Readiness, Option<i32>) {
    let started = std::time::Instant::now();
    let mut last = Readiness::PortClosed;
    loop {
        last = ready(crate::env::current_api_port(), READINESS_HTTP_TIMEOUT);
        if last == Readiness::Ready {
            return (last, None);
        }
        if let Ok(Some(st)) = child.try_wait() {
            if !st.success() {
                return (last, st.code());
            }
        }
        if started.elapsed() >= budget {
            return (last, None);
        }
        std::thread::sleep(std::time::Duration::from_millis(500));
    }
}

fn guard_log_tail() -> String {
    let path = crate::update::guard_log_path();
    let text = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(_) => return "(读不到)".to_string(),
    };
    let lines: Vec<&str> = text.lines().filter(|l| !l.trim().is_empty()).collect();
    let tail = lines[lines.len().saturating_sub(6)..].join("\n");
    let chars: Vec<char> = tail.chars().collect();
    let s: String = if chars.len() > 2000 {
        chars[chars.len() - 2000..].iter().collect()
    } else {
        tail.clone()
    };
    if s.trim().is_empty() { "(日志为空)".to_string() } else { s }
}

const SERVICE_READY_BUDGET: std::time::Duration = std::time::Duration::from_secs(30);
const DAEMON_READY_BUDGET: std::time::Duration = std::time::Duration::from_secs(60);

/// 守卫就绪判据的**唯一**实现产物：`GET /healthz` 返回 2xx —— 唯一算「就绪」的形态。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Readiness {
    Ready,
    PortClosed,
    Http(u16),
    NoHttpResponse,
}

impl Readiness {
    pub(crate) fn describe(self) -> String {
        match self {
            Readiness::Ready => "就绪".to_string(),
            Readiness::PortClosed => "端口不可达".to_string(),
            Readiness::Http(code) => format!("/healthz 返回 {}", code),
            Readiness::NoHttpResponse => "/healthz 无响应".to_string(),
        }
    }
}

/// 裸 TCP 可达判定 —— **只**用于「不再可达 = 进程已停」这类否定问题（重启前的等待）。就绪与否**不得**用它回答（那是 [`ready`] 的活）：端口能连只说明有人在听，守卫在绑定端口与真正可服务之间还有一大段启动过程。
pub(crate) fn port_open(port: u16) -> bool {
    let addr = format!("127.0.0.1:{}", port);
    if let Ok(mut it) = addr.to_socket_addrs() {
        if let Some(sa) = it.next() {
            return TcpStream::connect_timeout(&sa, std::time::Duration::from_millis(400)).is_ok();
        }
    }
    false
}

pub(crate) fn ready(port: u16, http_timeout: std::time::Duration) -> Readiness {
    if !port_open(port) {
        return Readiness::PortClosed;
    }
    match crate::domain::localhttp::http_get_local(port, "/healthz", http_timeout) {
        Some((code, _)) if (200..300).contains(&code) => Readiness::Ready,
        Some((code, _)) => Readiness::Http(code),
        None => Readiness::NoHttpResponse,
    }
}

/// 等待预算内轮询就绪（每 tick 500ms），返回最后一次判定。每 tick 重读实际端口：内核可能因端口占用而顺延并持久化（见 env::current_api_port），只盯固定端口会永远等不到已健康的守卫。用时长而非 tick 数计预算：每 tick 成本不是常数（多了 /healthz 一次往返），按 tick 计数会让总上界随网络状态漂移。
pub(crate) fn await_ready(budget: std::time::Duration) -> Readiness {
    let started = std::time::Instant::now();
    let mut last = Readiness::PortClosed;
    loop {
        last = ready(crate::env::current_api_port(), READINESS_HTTP_TIMEOUT);
        if last == Readiness::Ready || started.elapsed() >= budget {
            return last;
        }
        std::thread::sleep(std::time::Duration::from_millis(500));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::time::Duration;

    fn fake_guard(reply: Option<&'static [u8]>) -> u16 {
        let l = TcpListener::bind("127.0.0.1:0").expect("假守卫应能绑定回环端口");
        let port = l.local_addr().expect("回环监听必有地址").port();
        let bytes = reply.map(|b| b.to_vec());
        std::thread::spawn(move || {
            for stream in l.incoming().flatten() {
                let bytes = bytes.clone();
                std::thread::spawn(move || {
                    let mut stream = stream;
                    let mut buf = [0u8; 256];
                    let _ = stream.read(&mut buf);
                    match bytes {
                        Some(b) => {
                            let _ = stream.write_all(&b);
                            let _ = stream.flush();
                        }
                        None => std::thread::sleep(std::time::Duration::from_secs(3)),
                    }
                });
            }
        });
        port
    }

    fn closed_port() -> u16 {
        let l = TcpListener::bind("127.0.0.1:0").expect("应能绑定回环端口");
        l.local_addr().expect("回环监听必有地址").port()
    }

    /// 就绪判据必须**分辨得出**四种现场 —— 它们的可操作结论完全不同：没起来（继续等）/ 起了但病了（看日志）/ 应答 5xx（真失败）/ 健康（放行）；只回 `bool` 会让它们变成同一句话。
    #[test]
    fn readiness_distinguishes_closed_healthz_and_sick() {
        assert_eq!(
            ready(fake_guard(Some(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok")), Duration::from_millis(600)),
            Readiness::Ready
        );
        assert_eq!(
            ready(
                fake_guard(Some(b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\n\r\n")),
                Duration::from_millis(600)
            ),
            Readiness::Http(503)
        );
        assert_eq!(
            ready(fake_guard(None), Duration::from_millis(300)),
            Readiness::NoHttpResponse
        );
        assert_eq!(ready(closed_port(), Duration::from_millis(300)), Readiness::PortClosed);
    }

    #[test]
    fn readiness_describe_is_not_a_single_string() {
        let all = [
            Readiness::Ready.describe(),
            Readiness::PortClosed.describe(),
            Readiness::Http(500).describe(),
            Readiness::NoHttpResponse.describe(),
        ];
        assert!(all[2].contains("500"), "HTTP 判定必须带状态码: {}", all[2]);
        let uniq: std::collections::HashSet<_> = all.iter().collect();
        assert_eq!(uniq.len(), 4, "四种判定文案不得撞车: {:?}", all);
    }


}


const READINESS_HTTP_TIMEOUT: std::time::Duration = std::time::Duration::from_millis(800);
