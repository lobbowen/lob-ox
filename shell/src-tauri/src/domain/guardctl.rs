use std::net::{TcpStream, ToSocketAddrs};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use tauri::{Emitter, Manager};

static EXITING: AtomicBool = AtomicBool::new(false);
static PANEL_WATCH_RUNNING: AtomicBool = AtomicBool::new(false);
static PANEL_WATCH_ARMED: AtomicBool = AtomicBool::new(false);
static PANEL_WATCH_DOWN: AtomicU32 = AtomicU32::new(0);

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

pub(crate) enum AlignOutcome {
    
    Aligned { bin: std::path::PathBuf, version: String },
    ResolveFailed(String),
    NotAligned { latest: Option<String>, searched: Vec<String> },
}

pub(crate) fn resolve_aligned(app: &tauri::AppHandle) -> AlignOutcome {
    resolve_aligned_with(app.path().resource_dir().ok())
}

pub(crate) fn resolve_aligned_with(resource_dir: Option<std::path::PathBuf>) -> AlignOutcome {
    let pkg = match crate::core::package_name() {
        Ok(p) => p,
        Err(e) => return AlignOutcome::ResolveFailed(e),
    };
    let latest = match crate::core::latest_version(&pkg) {
        Ok((v, _o)) => v,
        Err(e) => return AlignOutcome::ResolveFailed(format!("{}：{}", pkg, e)),
    };
    let pkg_opt = Some(pkg.as_str());
    
    if let Some(c) = crate::core_contract::read() {
        let bin = crate::domain::coreloc::normalize_guard(c.bin, pkg_opt);
        if bin.is_file() && crate::core::semver_cmp(&c.version, &latest) == 0 {
            return AlignOutcome::Aligned { bin, version: latest };
        }
    }
    let cands = crate::domain::coreloc::locate_core_candidates(resource_dir);
    for c in &cands {
        let same = crate::core::installed_version(c)
            .map(|v| crate::core::semver_cmp(&v, &latest) == 0)
            .unwrap_or(false);
        if same {
            let prefix = crate::core::global_prefix_for(c);
            crate::core_contract::write(&crate::core_contract::InstalledCore {
                bin: c.clone(),
                prefix,
                version: latest.clone(),
                source: "local-adopted".into(),
            });
            return AlignOutcome::Aligned { bin: c.clone(), version: latest };
        }
    }
    AlignOutcome::NotAligned {
        latest: Some(latest),
        searched: cands.iter().map(|p| p.display().to_string()).collect(),
    }
}

pub fn resolve_local(resource_dir: Option<std::path::PathBuf>) -> Option<(crate::runtime_contract::NodeRuntime, std::path::PathBuf)> {
    let rt = crate::runtime_contract::ensure()?;
    let guard = crate::domain::coreloc::pick_highest(
        crate::domain::coreloc::locate_core_candidates(resource_dir),
    )?;
    Some((rt, guard))
}

pub(crate) fn shutdown_all(port: u16) {
    
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

pub(crate) struct ServiceLaunch {
    defined: Result<String, String>,
    started: Option<Result<(), String>>,
}

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

pub(crate) fn ensure_guard(app: &tauri::AppHandle) -> Result<(), LaunchError> {
    let port = crate::env::current_api_port();
    let step = |s: &str| {
        let _ = app.emit("guard_progress", serde_json::json!({ "status": s }));
        crate::update::log(s);
    };
        
    if port_open(port) {
        let verdict = serving_state(port);
        step(&verdict.note());
        if matches!(verdict, Serving::Alive | Serving::Sick) {
                        
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
            return Ok(());
        }
                
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
    let (guard, version) = match resolve_aligned(app) {
        AlignOutcome::Aligned { bin, version } => (bin, version),
        AlignOutcome::ResolveFailed(e) => {
            return Err(LaunchError::new("ALIGN_RESOLVE_FAILED", format!("内核版本对齐失败（线上不可达）：{}", e)));
        }
        AlignOutcome::NotAligned { latest, searched } => {
            let l = latest.unwrap_or_else(|| "?".into());
            return Err(LaunchError::new(
                "KERNEL_NOT_ALIGNED",
                format!(
                    "磁盘内核与线上最新（v{}）不一致，已拒绝启动旧内核；请先安装/更新内核。已搜索：{}",
                    l,
                    if searched.is_empty() { "（无候选）".into() } else { searched.join("、") }
                ),
            ));
        }
    };
    step(&format!("内核已对齐 v{}", version));
    let spec = crate::platform::LaunchSpec::from_runtime(&rt, guard)
        .map_err(|e| LaunchError::new("LAUNCH_SPEC_FAILED", e))?;
    ensure_started(&spec, &step)
}

pub(crate) fn ensure_started(
    spec: &crate::platform::LaunchSpec,
    step: &dyn Fn(&str),
) -> Result<(), LaunchError> {
    step("正在建立守卫服务定义…");
    let launch = ServiceLaunch::define_and_start(spec, step);

    if launch.start_requested() {
        step("等待守卫就绪（服务管理器路径）…");
        if await_ready(SERVICE_READY_BUDGET) == Readiness::Ready {
            return Ok(());
        }
    }

        
        
        
    step("服务管理器未能拉起守卫 · 改用直接启动…");
    let evidence = launch.evidence();
    match crate::platform::service().spawn_daemon(spec) {
        Ok(mut child) => {
            let pid = child.id();
            crate::update::log(&format!("兜底 spawn 守卫 pid={}", pid));
            let (verdict, exited) = await_daemon(DAEMON_READY_BUDGET, &mut child);
            if verdict == Readiness::Ready {
                return Ok(());
            }
            Err(LaunchError::new(
                "READY_TIMEOUT",
                format!(
                    "守卫启动失败（{}）。{}；直接拉起进程 pid={}{}，其输出见 {}\n守卫输出末段：{}",
                    verdict.describe(),
                    evidence,
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
            "SERVICE_START_FAILED",
            format!("守卫启动失败：{}；直接拉起也失败：{}", evidence, e),
        )),
    }
}

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
                
        _ => Serving::Alive,
    }
}

pub(crate) fn panel_view() -> (String, bool) {
    let port = crate::env::current_api_port();
    let serving = matches!(serving_state(port), Serving::Alive);
    (crate::env::api_base_url(), serving)
}

pub(crate) fn panel_watch_tick(down: u32, serving: bool, armed: bool, exiting: bool, needed: u32) -> (u32, bool) {
    if exiting || !armed { return (0, false); }
    if serving { return (0, false); }
    let n = down + 1;
    if n >= needed { return (0, true) }
    (n, false)
}

pub(crate) fn watch_panel(app: &tauri::AppHandle) {
    PANEL_WATCH_ARMED.store(true, Ordering::SeqCst);
    if PANEL_WATCH_RUNNING.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst).is_err() {
        return;
    }
    let h = app.clone();
    std::thread::spawn(move || {
        loop {
            std::thread::sleep(PANEL_WATCH_INTERVAL);
            if !PANEL_WATCH_ARMED.load(Ordering::SeqCst) {
                PANEL_WATCH_DOWN.store(0, Ordering::SeqCst);
                continue;
            }
            let serving = matches!(serving_state(crate::env::current_api_port()), Serving::Alive);
            let prev = PANEL_WATCH_DOWN.load(Ordering::SeqCst);
            let (next, bounce) = panel_watch_tick(
                prev, serving,
                PANEL_WATCH_ARMED.load(Ordering::SeqCst),
                EXITING.load(Ordering::SeqCst),
                PANEL_WATCH_DOWN_TICKS,
            );
            PANEL_WATCH_DOWN.store(next, Ordering::SeqCst);
            if bounce {
                PANEL_WATCH_ARMED.store(false, Ordering::SeqCst);
                crate::update::log(&format!(
                    "[panel-watch] 连续 {}s 守卫不在服役 · 回引导页重跑启动链",
                    PANEL_WATCH_INTERVAL.as_secs() * PANEL_WATCH_DOWN_TICKS as u64
                ));
                let _ = h.emit("shell:goto-bootstrap", serde_json::json!({}));
            }
        }
    });
}

const PANEL_WATCH_INTERVAL: std::time::Duration = std::time::Duration::from_secs(5);
const PANEL_WATCH_DOWN_TICKS: u32 = 3;

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

const GUARD_RELEASE_BUDGET: std::time::Duration = std::time::Duration::from_secs(15);

const SERVING_PROBE_TIMEOUT: std::time::Duration = std::time::Duration::from_millis(1200);

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

    #[test]
    fn panel_watch_bounces_only_after_consecutive_down_ticks() {
        assert_eq!(panel_watch_tick(0, true, true, false, 3), (0, false), "在服役必须归零拍数");
        assert_eq!(panel_watch_tick(2, true, true, false, 3), (0, false), "失服役后要重新攒满");
        assert_eq!(panel_watch_tick(1, false, true, false, 3), (2, false), "未达门槛只攒拍不甩页");
        assert_eq!(panel_watch_tick(2, false, true, false, 3), (0, true), "连续达门槛才回引导页");
        assert_eq!(panel_watch_tick(9, false, false, false, 3), (0, false), "已解除观察态不得再甩页");
        assert_eq!(panel_watch_tick(9, false, true, true, 3), (0, false), "退出握手中不得甩页");
    }
}

const READINESS_HTTP_TIMEOUT: std::time::Duration = std::time::Duration::from_millis(800);
