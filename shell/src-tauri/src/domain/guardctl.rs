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

pub(crate) fn shutdown_all(port: u16) {
    // 退出握手：1) 带超时请求内核停全部被管对象并等回执（守卫挂起时壳不无限阻塞）；2) 轮询 sessionState 直到 stopped（守卫已不可达同样视为完成）；3) 由所有者停止守卫进程 —— 守卫自身从不停止自己（所有权归一）。握手最长约 70s，其间「不在服役」是预期结果，监控必须闭嘴。
    EXITING.store(true, Ordering::SeqCst);
    let _ = crate::domain::localhttp::post_local_timeout(port, "/session/stop", std::time::Duration::from_secs(60));
    for _ in 0..40 {
        match crate::domain::localhttp::get_session_state(port) {
  Some(s) if s == "stopped" => break,
  None => break,
            _ => std::thread::sleep(std::time::Duration::from_millis(250)),
        }
    }
    match crate::platform::service().stop() {
        Ok(()) => crate::update::log("[shell] 退出握手完成：守卫已停止，本次登录内不会自动拉起；重新打开程序即恢复"),
        Err(e) => {
            eprintln!("[shell] 停止守卫失败: {}", e);
            crate::update::log(&format!("[shell] 停止守卫失败: {}", e));
        }
    }
}

/// 服务管理器路径（P4 建立定义 -> P5 请求启动）的阶段产物。不变量由结构强制：`started` 只可能在 `defined` 为 `Ok` 时才是 `Some` —— 定义失败时那条出边是关闭的。丢掉 `ensure_defined` 的错误再无条件 `start()`，报错就只剩「/Run 失败（退出码 1）」，真实失败点可能在更早的 P4。
impl ServiceLaunch {
    fn define_and_start(spec: &crate::platform::LaunchSpec, report: &dyn Fn(&str)) -> Self {
        let defined = match crate::platform::service().ensure_defined(spec) {
            Ok(desc) => {
                crate::update::log(&format!("守卫服务定义: {}", desc));
                Ok(desc)
            }
            Err(e) => {
                crate::update::log(&format!("守卫服务定义失败（跳过启动请求，改走直接拉起）: {}", e));
                Err(e)
            }
        };
        let started = match &defined {
            Ok(_) => {
                report("正在请求服务管理器启动守卫…");
                let r = crate::platform::service().start();
                if let Err(e) = &r {
                    crate::update::log(&format!("服务管理器启动失败: {}", e));
                }
                Some(r)
            }
            Err(_) => None,
        };
        ServiceLaunch { defined, started }
    }

    fn start_requested(&self) -> bool {
        matches!(self.started, Some(Ok(())))
    }

    fn evidence(&self) -> String {
        match (&self.defined, &self.started) {
            (Err(d), None) => format!("服务定义未建立（因此未请求服务管理器启动）：{}", d),
            (Err(d), Some(_)) => format!("服务定义未建立：{}", d),
            (Ok(_), Some(Err(e))) => format!("服务管理器错误：{}", e),
            (Ok(_), Some(Ok(()))) => "服务管理器已接受启动请求，但守卫未在其间就绪".to_string(),
            (Ok(d), None) => format!("服务定义已建立（{}），未发起启动请求", d),
        }
    }
}

/// 内核进程登记表项：把「内核」作为最高优先级负载收进机箱进程表。
/// 这是进程所有权归壳的体现 —— 表里没有内核，自愈就无从谈起。
fn core_desc() -> crate::process_manager::state_machine::WorkloadDesc {
    crate::process_manager::state_machine::WorkloadDesc {
        id: "core".to_string(),
        spawn_cmd: Vec::new(),
        priority: crate::process_manager::state_machine::Priority::Core,
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

pub(crate) fn ensure_guard(app: &tauri::AppHandle) -> Result<(), LaunchError> {
    let port = crate::env::current_api_port();
    let step = |s: &str| {
        let _ = app.emit("guard_progress", serde_json::json!({ "status": s }));
        crate::update::log(s);
    };
        // 早退必须回答「这个守卫还在为本产品服役吗」，而不是「端口上有没有人」：走完 /session/stop 握手的守卫进程还占着端口，服务链却已拆光，据此早退会把面板交给一个不再干活的守卫（观感＝127.0.0.1 拒绝连接），而 P5 的即时启动只会让新守卫撞守卫锁退出。
    if port_open(port) {
        let verdict = serving_state(port);
        step(&verdict.note());
        if matches!(verdict, Serving::Alive | Serving::Sick) {
                        // 守卫已在服役（或只是还没应答）时也确保一次服务定义：退出时 Windows stop() 会 /Delete 监控任务，而登录任务可能已先拉起守卫使本函数提前返回，那样监控任务永不重建、崩溃自愈在本会话内失效。ensure_defined 三平台幂等且自愈，也不得引入平台分支。
            if let Some((rt_wd, guard_wd)) = resolve_local(None) {
                match crate::platform::LaunchSpec::from_runtime(&rt_wd, guard_wd) {
                    Ok(spec_wd) => {
                        if let Err(e) = crate::platform::service().ensure_defined(&spec_wd) {
                            crate::update::log(&format!("守卫已在运行，但服务定义确保失败: {}", e));
                        }
                    }
                    Err(e) => crate::update::log(&format!("守卫已在运行，但启动规格组装失败: {}", e)),
                }
            }
            register_core(app);
            return Ok(());
        }
                // 唯一的例外：进程活着但服务链已拆（走过 /session/stop）。由所有者先把它停干净，再落回下面的正常启动序列 —— 监控通道刚被 stop() 摘掉，没有第二条恢复路径。
        if !stop_and_await_release(port) {
            return Err(LaunchError::new(
                "GUARD_STOP_FAILED",
                format!(
                    "守卫会话已停但进程未在预算内让出端口 {}，故未重拉。守卫日志末段：{}",
                    port,
                    guard_log_tail()
                ),
            ));
        }
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

/// 「守卫还在为本产品服役吗」——`ready()`（TCP + /healthz 2xx）**且**会话没在退出链里。裸 TCP 单独回答不了这个问题：服务链拆完的守卫照样 accept 连接，`/healthz` 也照样 2xx，只有 `/session/status` 说真话。
#[derive(Debug)]
pub(crate) enum Serving {
    Alive,
    Sick,
    SessionHalted(String),
}

impl Serving {
    pub(crate) fn note(&self) -> String {
        match self {
            Serving::Alive => "守卫在服役 · 跳过启动".to_string(),
            Serving::Sick => "守卫端口已开但未应答 /healthz · 不重复启动，等待就绪判定".to_string(),
            Serving::SessionHalted(state) => {
                format!("守卫在监听但会话已停（{}）· 由所有者先停干净再重拉", state)
            }
        }
    }
}

pub(crate) fn serving_state(port: u16) -> Serving {
    if ready(port, SERVING_PROBE_TIMEOUT) != Readiness::Ready {
        return Serving::Sick;
    }
    match crate::domain::localhttp::get_session_state(port) {
        Some(s) if s == "stopping" || s == "stopped" => Serving::SessionHalted(s),
                // 读不到会话态就按「在服役」处理：探针抖动不得升级成「停掉一个健康守卫」。
        _ => Serving::Alive,
    }
}

/// 面板投影的**唯一**判据：URL 与「此刻能不能投」必须同出一个答案。分两处问就会失效：`go_panel` 查了服役、`shell_panel_url` 没查，而壳框架主帧一定先按后者导航，于是被查过的那次判定永远来不及生效。
pub(crate) fn panel_view() -> (String, bool) {
    let port = crate::env::current_api_port();
    let serving = matches!(serving_state(port), Serving::Alive);
    (crate::env::api_base_url(), serving)
}


/// 由所有者把守卫停干净：`service().stop()` + 等端口**不再可达**（裸 TCP 在此问的是「还在不在」，是 `port_open` 的合法用途）。返回 false = 预算内端口仍被占，此时重拉只会撞守卫锁退出，调用方必须如实失败而不是假装重启过。
fn stop_and_await_release(port: u16) -> bool {
    if let Err(e) = crate::platform::service().stop() {
        crate::update::log(&format!("重拉前的停止请求失败: {}", e));
    }
    let start = std::time::Instant::now();
    while start.elapsed() < GUARD_RELEASE_BUDGET {
        if !port_open(port) {
            return true;
        }
        std::thread::sleep(std::time::Duration::from_millis(250));
    }
    !port_open(port)
}

/// 等守卫让出端口的预算：`stop()` 是异步的（杀进程 + 内核回收），15 秒覆盖真机上观察到的退出耗时；再长就是在启动路径上干等，不如把失败如实报出去。
const GUARD_RELEASE_BUDGET: std::time::Duration = std::time::Duration::from_secs(15);

const SERVING_PROBE_TIMEOUT: std::time::Duration = std::time::Duration::from_millis(1200);

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

    const HEALTHZ_OK: &[u8] = b"HTTP/1.1 200 OK\r\nConnection: close\r\n\r\nok";
    const HEALTHZ_503: &[u8] = b"HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n";
    const SESSION_ACTIVE: &[u8] =
        b"HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n{\"sessionState\":\"active\"}";
    const SESSION_STOPPED: &[u8] =
        b"HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n{\"sessionState\":\"stopped\"}";
    const SESSION_UNKNOWN: &[u8] = b"HTTP/1.1 200 OK\r\nConnection: close\r\n\r\nnot json";

    fn fake_serving(healthz: &'static [u8], session: &'static [u8]) -> u16 {
        let l = TcpListener::bind("127.0.0.1:0").expect("假守卫应能绑定回环端口");
        let port = l.local_addr().expect("回环监听必有地址").port();
        std::thread::spawn(move || {
            for stream in l.incoming().flatten() {
                std::thread::spawn(move || {
                    let mut stream = stream;
                    let mut buf = [0u8; 256];
                    let n = stream.read(&mut buf).unwrap_or(0);
                    let req = String::from_utf8_lossy(&buf[..n]).into_owned();
                    let reply = if req.contains("GET /healthz") { healthz } else { session };
                    let _ = stream.write_all(reply);
                    let _ = stream.flush();
                });
            }
        });
        port
    }

    #[test]
    fn serving_state_separates_alive_from_halted_but_listening() {
        assert!(matches!(serving_state(fake_serving(HEALTHZ_OK, SESSION_ACTIVE)), Serving::Alive));
        assert!(matches!(serving_state(fake_serving(HEALTHZ_OK, SESSION_UNKNOWN)), Serving::Alive));
        assert!(matches!(serving_state(fake_serving(HEALTHZ_503, SESSION_STOPPED)), Serving::Sick));
        assert!(matches!(serving_state(closed_port()), Serving::Sick));
        match serving_state(fake_serving(HEALTHZ_OK, SESSION_STOPPED)) {
            Serving::SessionHalted(s) => assert_eq!(s, "stopped"),
            other => panic!("停链守卫必须判为 SessionHalted，实得 {:?}", other),
        }
    }

}


const READINESS_HTTP_TIMEOUT: std::time::Duration = std::time::Duration::from_millis(800);
