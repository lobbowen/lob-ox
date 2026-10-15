//! 机箱 loopback 管理端点（Y 模式：底座持有的真相，由内核子进程单向上报）。
//!
//! 拓扑：壳（父）经 spawn_daemon 拉起内核（子）；内核无反向 invoke 壳的通道，
//! 故底座在此暴露 127.0.0.1 的极简 HTTP 端点（端口受 PortAuthority 唯一分配，
//! 登记为 guard-mgmt），内核经 HTTP POST 上报 register / set-desired / on-phase /
//! record-exit。浏览器策略天然封死跨源；底座持有唯一真相。

use std::convert::Infallible;
use std::sync::Arc;

use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use hyper::body::Incoming;
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Request, Response, StatusCode};
use hyper_util::rt::TokioIo;

use crate::process_manager::state_machine;
use crate::process_manager::ProcessManager;

/// 契约文件是否已被一个**在世**的进程持有。pid 只由本文件写入，
/// 故读到的 pid 可直接判活（与 pm-client.js 的 endpoint() 同一判据）。
fn live_contract_owner() -> Option<u32> {
    let path = crate::env::supervisor_dir().join("guard-mgmt.json");
    let text = std::fs::read_to_string(path).ok()?;
    let v: serde_json::Value = serde_json::from_str(&text).ok()?;
    let pid = v.get("pid")?.as_u64()? as u32;
    if pid == std::process::id() {
        return Some(pid);
    }
    if crate::bounded::pid_alive(pid) { Some(pid) } else { None }
}

pub async fn run(state: Arc<ProcessManager>) {
    // guard-mgmt.json 是**单所有者**契约：已有在世所有者时本进程不得接管。
    // 否则后起的 --run-guard 子进程会把壳的端口覆盖成自己的，内核上报随即
    // 全部落进这张没人查询、没人 heal 的临时表。
    if let Some(pid) = live_contract_owner() {
        crate::telemetry::event::info("mgmt.owner_alive", "process_manager", serde_json::json!({ "pid": pid }));
        return;
    }
    let listener = match tokio::net::TcpListener::bind("127.0.0.1:0").await {
        Ok(l) => l,
        Err(e) => {
            crate::telemetry::event::error("mgmt.bind_failed", "process_manager", serde_json::json!({ "addr": "127.0.0.1:0", "error": format!("{}", e) }));
            return;
        }
    };
    let port = listener.local_addr().map(|a| a.port()).unwrap_or(0);
    // 端口受机箱权威分配：OS 分配后回写（等效 allocate 但避开竞争窗口）。
    if let Ok(mut guard) = state.ports.lock() {
        let _ = guard.register_sole("guard-mgmt", port);
    }
    crate::telemetry::event::info("mgmt.listening", "process_manager", serde_json::json!({ "port": port }));
    // 端口回灌内核（壳写内核读，单向）：内核 daemon 与 GUI 壳是两个独立进程
    //   （--run-guard 走 exec 替换，壳进程不再存在），故不能用父传子 env，改走落盘契约。
    // 令牌根不可得 → 不写契约文件：内核读不到端点即静默降级，
    // 而挂着可预测凭据的端点可被本机任意进程用来执行任意 spawn_cmd。
    if let Err(e) = export_port(port) {
        crate::telemetry::event::warn("mgmt.contract_not_persisted", "process_manager", serde_json::json!({ "error": format!("{}", e) }));
    }
    loop {
        let (stream, _addr) = match listener.accept().await {
            Ok(x) => x,
            Err(_) => continue,
        };
        let io = TokioIo::new(stream);
        let st = state.clone();
        tokio::spawn(async move {
            let svc = service_fn(move |req: Request<Incoming>| {
                let st = st.clone();
                async move { handle(st, req).await }
            });
            if let Err(e) = http1::Builder::new().serve_connection(io, svc).await {
                crate::telemetry::event::warn("mgmt.connect_error", "process_manager", serde_json::json!({ "error": format!("{}", e) }));
            }
        });
    }
}

/// 把 guard-mgmt 端口回灌给内核（所有权在壳、方向单向：壳写内核读）。
/// 范式同 `mirror::export_to_kernel`：tmp → rename 原子提交，内核侧读不到就当端点不存在（客户端静默降级）。
// 令牌头名真相来自 shared-constants.json（经 brand::shared_str 读取）。
// 不能用 const：解析器依赖运行期字符串操作（const 初始化里调用非 const fn 会 E0015）。
// OnceLock 保证只解析一次——范式同 env.rs 的 DEFAULT_API_PORT_CELL。
static MGMT_TOKEN_HEADER_CELL: std::sync::OnceLock<&'static str> = std::sync::OnceLock::new();
fn mgmt_token_header() -> &'static str {
    MGMT_TOKEN_HEADER_CELL.get_or_init(|| crate::brand::shared_str("bridge.mgmtTokenHeader"))
}

const MGMT_BODY_CAP: usize = 64 * 1024;

// R3 / 攻击链 B：机箱管理端点的 peer 凭据。
//
// 原实现用 DefaultHasher(port + CLI_NAME) 派生。DefaultHasher 是零键 SipHash，
// 输出确定可复现：任意本机进程读到 guard-mgmt.json（此前 0o644）拿到 port 即可
// 本地算出 token，然后 POST 一个 spawn_cmd 为任意可执行文件的 WorkloadDesc，
// healer 每 5 秒以壳的权限执行它。Windows 上 schtasks 用了 /RL HIGHEST，
// 即完整的本地提权链。
//
// 修为：进程启动时生成 256-bit 随机根，令牌按端口 SHA256 派生。
//   - 每个管理面一个令牌，泄漏一个不影响其他面；
//   - 根不可复现，本机其他进程无法推算；
//   - 比较用常量时间。
//
// 熵源失败时 **fail-closed**（返回 Err）：早期版本在此退化成
// 「时间纳秒 ^ pid ^ 栈地址」且后半段是前半段按位取反，有效熵只有 128 bit 且 pid 全世界可读，
// 可被本地爆破——而当时的注释仍声称「不可复现」。宁可管理端点起不来（内核降级静默），
// 也不能挂一个可预测的凭据。

use std::sync::OnceLock;

static MGMT_TOKEN_ROOT: OnceLock<[u8; 32]> = OnceLock::new();

fn system_entropy() -> Option<[u8; 32]> {
    let mut seed = [0u8; 32];
    let mut ok = false;
    unsafe {
        #[cfg(target_os = "windows")]
        {
            extern "system" {
                fn BCryptGenRandom(hAlgorithm: *mut core::ffi::c_void, pbBuffer: *mut u8, cbBuffer: u32, dwFlags: u32) -> i32;
            }
            const BCRYPT_USE_SYSTEM_PREFERRED_RNG: u32 = 0x00000002;
            let rc = BCryptGenRandom(
                core::ptr::null_mut(),
                seed.as_mut_ptr(),
                seed.len() as u32,
                BCRYPT_USE_SYSTEM_PREFERRED_RNG,
            );
            // STATUS_SUCCESS == 0
            ok = rc == 0;
        }
        #[cfg(not(target_os = "windows"))]
        {
            if let Ok(mut f) = std::fs::File::open("/dev/urandom") {
                use std::io::Read;
                ok = f.read_exact(&mut seed).is_ok();
            }
        }
    }
    if ok { Some(seed) } else { None }
}

fn mgmt_token_root() -> Result<&'static [u8; 32], String> {
    if let Some(r) = MGMT_TOKEN_ROOT.get() {
        return Ok(r);
    }
    let seed = system_entropy().ok_or_else(|| {
        "系统熵源不可用：拒绝以可预测种子派生 guard-mgmt 令牌（fail-closed）".to_string()
    })?;
    Ok(MGMT_TOKEN_ROOT.get_or_init(|| seed))
}

fn mgmt_token(port: u16) -> Result<String, String> {
    use sha2::{Digest, Sha256};
    let root = mgmt_token_root()?;
    let mut h = Sha256::new();
    h.update(root);
    h.update(b"lobox-mgmt:");
    h.update(port.to_string().as_bytes());
    let digest = h.finalize();
    Ok(hex::encode(&digest[..16]))
}

fn token_eq(got: &str, want: &str) -> bool {
    let a = got.as_bytes();
    let b = want.as_bytes();
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for i in 0..a.len() {
        diff |= a[i] ^ b[i];
    }
    diff == 0
}
fn export_port(port: u16) -> Result<(), String> {
    let path = crate::env::supervisor_dir().join("guard-mgmt.json");
    let body = match serde_json::to_string_pretty(&serde_json::json!({
        "schema": 1,
        "role": "guard-mgmt",
        "host": "127.0.0.1",
        "port": port,
        "token": mgmt_token(port)?,
        "pid": std::process::id(),
        "at": std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0),
    })) {
        Ok(b) => b,
        Err(e) => return Err(format!("端口契约序列化失败: {e}")),
    };
    // 原子提交收口到 atomic_write（失败即清理 tmp）。
    crate::atomic_write::write(&path, &(body + "\n")).map_err(|e| format!("端口契约落盘失败: {e}"))
}

// 错误类型用 Infallible：内核上报表单是「尽力而为」的控制面，任一环节失败都就地转成 4xx/5xx 响应，
// 不应让整条连接 panic 或被 serve_connection 要求 Into<Box<dyn Error+'static>>（那会逼出 From 生命周期错误）。
async fn handle(
    state: Arc<ProcessManager>,
    req: Request<Incoming>,
) -> Result<Response<Full<Bytes>>, Infallible> {
    let method = req.method().clone();
    let path = req.uri().path().to_string();
    // body 收集失败（连接异常）兜底为空字节，交由后续解析分支返回 400。
    let port = state
        .ports
        .lock()
        .ok()
        .and_then(|g| g.get("guard-mgmt"))
        .unwrap_or(0);
    let want_token = match mgmt_token(port) {
        Ok(t) => t,
        Err(e) => return Ok(reply(StatusCode::INTERNAL_SERVER_ERROR, &format!("mgmt token unavailable: {e}"))),
    };
    let got_token = req
        .headers()
        .get(mgmt_token_header())
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if port == 0 || !token_eq(got_token, want_token.as_str()) {
        return Ok(reply(StatusCode::UNAUTHORIZED, "mgmt token mismatch"));
    }
    let body = match req.into_body().collect().await {
        Ok(c) => c.to_bytes(),
        Err(_) => Bytes::new(),
    };
    if body.len() > MGMT_BODY_CAP {
        return Ok(reply(StatusCode::PAYLOAD_TOO_LARGE, "body too large"));
    }
    let json: serde_json::Value = if body.is_empty() {
        serde_json::Value::Null
    } else {
        match serde_json::from_slice::<serde_json::Value>(&body) {
            Ok(j) => j,
            Err(_) => return Ok(reply(StatusCode::BAD_REQUEST, "bad json")),
        }
    };
    // 上报被接受与否必须如实回报：此前四个分支无论 id/phase/desired 是否缺失或不可解析
    // 一律回 200，而 pm-client.js 的 post 对任何 2xx 返回 true 并吞掉——
    // 两层都报「成功」而状态从未改变（例如 core 上报 installing 会被静默丢弃）。
    // 这里改为：解析失败返回 4xx 并带明确原因。
    match (method.as_str(), path.as_str()) {
        ("POST", "/pm/register") => match parse_desc(&json) {
            Some(desc) => {
                state.register_workload(desc);
                Ok(reply(StatusCode::OK, "ok"))
            }
            None => Ok(reply(StatusCode::BAD_REQUEST, "register: id 缺失或不是字符串")),
        },
        ("POST", "/pm/set-desired") => {
            match json.get("id").and_then(|v| v.as_str()) {
                None => Ok(reply(StatusCode::BAD_REQUEST, "set-desired: id 缺失或不是字符串")),
                Some(id) => match json
                    .get("desired")
                    .and_then(|v| v.as_str())
                    .and_then(parse_desired)
                {
                    Some(d) => {
                        state.set_desired(id, d);
                        Ok(reply(StatusCode::OK, "ok"))
                    }
                    None => Ok(reply(
                        StatusCode::BAD_REQUEST,
                        &format!("set-desired: desired 不可解析: {:?}", json.get("desired")),
                    )),
                },
            }
        }
        ("POST", "/pm/on-phase") => {
            match json.get("id").and_then(|v| v.as_str()) {
                None => Ok(reply(StatusCode::BAD_REQUEST, "on-phase: id 缺失或不是字符串")),
                Some(id) => match json.get("phase").and_then(|v| v.as_str()).and_then(parse_phase) {
                    Some(p) => {
                        state.on_phase(id, p);
                        Ok(reply(StatusCode::OK, "ok"))
                    }
                    None => Ok(reply(
                        StatusCode::BAD_REQUEST,
                        &format!("on-phase: phase 不可解析: {:?}", json.get("phase")),
                    )),
                },
            }
        }
        ("POST", "/pm/record-exit") => match json.get("id").and_then(|v| v.as_str()) {
            None => Ok(reply(StatusCode::BAD_REQUEST, "record-exit: id 缺失或不是字符串")),
            Some(id) => {
                let code = json.get("code").and_then(|v| v.as_i64()).map(|x| x as i32);
                let signal = json.get("signal").and_then(|v| v.as_str()).map(|s| s.to_string());
                // startup_failure 缺省 false（未知不当失败）。
                let startup_failure = json
                    .get("startup_failure")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                state.record_exit(
                    id,
                    state_machine::LastWill {
                        code,
                        signal,
                        at: std::time::Instant::now(),
                        startup_failure,
                    },
                );
                Ok(reply(StatusCode::OK, "ok"))
            }
        }
        _ => Ok(reply(StatusCode::NOT_FOUND, "not found")),
    }
}


fn reply(status: StatusCode, msg: &str) -> Response<Full<Bytes>> {
    Response::builder()
        .status(status)
        .body(Full::new(Bytes::from(msg.as_bytes().to_vec())))
        .unwrap_or_else(|_| Response::new(Full::new(Bytes::from_static(b"err"))))
}

fn parse_desc(v: &serde_json::Value) -> Option<state_machine::WorkloadDesc> {
    let id = v.get("id")?.as_str()?.to_string();
    let spawn_cmd = v
        .get("spawn_cmd")
        .and_then(|a| a.as_array())
        .map(|arr| arr.iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect())
        .unwrap_or_default();
    // env：负载启动时需要的环境变量覆盖。沙箱实例靠它维持数据隔离，
    // 缺失时 heal 重拉的进程会写进真实用户目录。
    let env = v
        .get("env")
        .and_then(|a| a.as_object())
        .map(|obj| {
            let mut pairs: Vec<(String, String)> = obj
                .iter()
                .filter_map(|(k, val)| val.as_str().map(|s| (k.clone(), s.to_string())))
                .collect();
            // 排序保证同一次注册产生的 env 顺序稳定，便于对账与测试。
            pairs.sort_by(|a, b| a.0.cmp(&b.0));
            pairs
        })
        .unwrap_or_default();
    Some(state_machine::WorkloadDesc {
        id,
        spawn_cmd,
        priority: parse_priority(v.get("priority").and_then(|x| x.as_str())),
        env,
    })
}

/// 内核自报时未带 priority 的，一律按最低优先级入表（内核自己报的对象都不是存活前提）。
fn parse_priority(s: Option<&str>) -> state_machine::Priority {
    match s {
        Some("core") => state_machine::Priority::Core,
        Some("router") => state_machine::Priority::Router,
        Some("lan") => state_machine::Priority::Lan,
        Some("sandbox") => state_machine::Priority::Sandbox,
        _ => state_machine::Priority::Plugin,
    }
}

fn parse_phase(s: &str) -> Option<state_machine::Phase> {
    // installing：core 的生命周期状态机确有 INSTALLING（lifecycle.js 会上报），
    // Rust 侧此前没有这个值 → 静默丢弃并回 200，故补进枚举而非在 parse 处猜。
    Some(match s {
        "stopped" => state_machine::Phase::Stopped,
        "starting" => state_machine::Phase::Starting,
        "installing" => state_machine::Phase::Installing,
        "running" => state_machine::Phase::Running,
        "draining" => state_machine::Phase::Draining,
        "failed" => state_machine::Phase::Failed,
        _ => return None,
    })
}

fn parse_desired(s: &str) -> Option<state_machine::Desired> {
    Some(match s {
        "running" => state_machine::Desired::Running,
        "stopped" => state_machine::Desired::Stopped,
        _ => return None,
    })
}
