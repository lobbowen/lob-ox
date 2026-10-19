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
///
/// `pub` 而非私有：`domain/guardctl.rs:92,206` 跨模块调它（`shutdown_all` 的
/// 契约兜底 + `register_core` 的认领取 pid）。此前是 `fn` ⇒ E0603
/// 「function is private」⇒ CI 两处报错。**跨模块调用要求符号 `pub`** ——
/// 这是 Rust 的编译期守卫，本机无 cargo 时只能靠 grep 核（见 §36）。
pub fn live_contract_owner() -> Option<u32> {
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
    match export_port(port) {
        ContractWrite::Written => {}
        ContractWrite::NotWritten(e) => {
            crate::telemetry::event::warn("mgmt.contract_not_persisted", "process_manager", serde_json::json!({ "error": e }));
            crate::update::log(&format!("[mgmt] 端口契约未落盘，管理端点不可用: {}", e));
            return;
        }
        ContractWrite::PermissionNotSet(e) => {
            // 权限未收口 ≠ 端点不可用：字节已落盘（atomic_write 的 Ok 分支），
            // 内核读得到端口与令牌，控制面可用。此处 return 会让 Windows 上
            // 每次启动都因「无 POSIX 权限位」而放弃管理端点——那是功能回退，
            // 比权限敞开更严重（后者只是同机其他用户可能读到 token，前者是功能全无）。
            // 处置：端点照起，权限事实如实落事件与日志，由运维按需加固。
            crate::telemetry::event::warn("mgmt.contract_permission", "process_manager", serde_json::json!({ "error": e }));
            crate::update::log(&format!(
                "[mgmt] guard-mgmt.json 已写入但权限未收口（{}）——管理端点继续启动，请按需收口 ACL",
                e
            ));
        }
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

/// 系统熵源。取 32 字节随机种子。
///
/// `pub` 是为了让 `platform::spawn_token` 复用同一份 FFI —— 那处曾复制一份
/// `BCryptGenRandom` 声明，正是「复制而非复用」的病（与 `core_spawn_cmd` 同源）。
/// 两侧都用它：本文件派生 mgmt 令牌根，`spawn_token` 派生一次性凭据。
pub fn system_entropy_for_spawn() -> Option<[u8; 32]> {
    system_entropy()
}

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
/// 契约落盘的三种结局。用 enum 而非 `Result`：三种结局的可操作结论完全不同
/// （落盘可用 / 没写进去 / 写进去了但权限没收口），压成两个槽位会让
/// 「权限未设」被读成「没写」或反之。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ContractWrite {
    Written,
    NotWritten(String),
    PermissionNotSet(String),
}

fn export_port(port: u16) -> ContractWrite {
    let path = crate::env::supervisor_dir().join("guard-mgmt.json");
    let token = match mgmt_token(port) {
        Ok(t) => t,
        Err(e) => return ContractWrite::NotWritten(format!("令牌根不可得: {}", e)),
    };
    let body = match serde_json::to_string_pretty(&serde_json::json!({
        "schema": 1,
        "role": "guard-mgmt",
        "host": "127.0.0.1",
        "port": port,
        "token": token,
        "pid": std::process::id(),
        "at": std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0),
    })) {
        Ok(b) => b,
        Err(e) => return ContractWrite::NotWritten(format!("端口契约序列化失败: {}", e)),
    };
    // 原子提交 + 属主可读收口。mode 由本调用点给出：写给内核读，
    // 同机其他用户不应可读（文件含 mgmt token）。
    match crate::atomic_write::write_private(&path, &(body + "\n"), 0o600) {
        Err(e) => ContractWrite::NotWritten(e),
        Ok(crate::atomic_write::Outcome::Written) => ContractWrite::Written,
        Ok(crate::atomic_write::Outcome::PermissionNotSet { mode, reason }) => {
            ContractWrite::PermissionNotSet(format!("阶段 {}：{}（文件已落盘但权限未达 0o600）", mode, reason))
        }
    }
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
    let ua = req
        .headers()
        .get("user-agent")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
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
    //
    // GET /pm/status 是壳侧唯一的对外读口（此前 mgmt 端点 GET=0，壳的进程表没有
    // 任何探针够得着的读接口）。它让「一个文件连真机产品做完整检测」成为可能：
    // 内核侧有 179 个 HTTP 路由可探，壳侧此前一个都没有。
    //
    // 鉴权与 POST 同一条路（上面的 token 校验在 match 之前，GET 自动继承），
    // 不另开免鉴权的读口——那等于把进程表暴露给本机任意进程。
    if method.as_str() == "GET" && path.as_str() == "/pm/status" {
        // 读口也要留痕：禁静默。否则「谁在什么时候探过壳」无从回答，
        // 而这个读口一旦被滥用（轮询/扫描），唯一的证据就是这条事件。
        crate::telemetry::event::info("mgmt.status_read", "process_manager", serde_json::json!({
            "peer": ua
        }));
        return Ok(reply(StatusCode::OK, &status_json(&state)));
    }
    match (method.as_str(), path.as_str()) {
        ("POST", "/pm/register") => match parse_desc(&json) {
            Some(desc) => {
                // W-2-1（architect 裁）：`/pm/register` 加**可选的 `pid` 字段**。
                //
                // 为什么：此前 register 只建「机制」行（id/spawn_cmd/priority/env）而
                // pid 恒空 ⇒ 于是 `/pm/keep-alive` 报 pid 时 `update_pid` 找不到行
                // ⇒ 记 `dsh_main_row_missing` ⇒ 而那是「壳知道有 DSH 但进程表没有它」。
                //
                // 为什么用「声明」而不是「测量」：architect 裁的 W-2-1 ——
                // 用声明代替测量。壳**不自己探** DSH 的 pid（那会造第二套发现），
                // 而是让内核在 register 时一并声明「这个行对应的 pid 是多少」。
                //
                // 为什么可选：老版本内核不带它 ⇒ 不带时保持原行为（只建行）。
                let id = desc.id.clone();
                state.register_workload(desc);
                if let Some(pid) = json.get("pid").and_then(|v| v.as_u64()).map(|p| p as u32) {
                    if pid > 0 {
                        state.update_pid(&id, pid);
                        crate::telemetry::event::info(
                            "mgmt.registered_with_pid",
                            "process_manager",
                            serde_json::json!({ "id": id, "pid": pid, "via": "register" }),
                        );
                    }
                }
                Ok(reply(StatusCode::OK, "ok"))
            }
            None => Ok(reply(StatusCode::BAD_REQUEST, "register: id 缺失或不是字符串")),
        },
        // 壳 API「谁进 job」：内核 spawn 一个**该随壳死**的后代后，把它的 pid
        // 报给壳，由壳 assign 进「壳退即全杀」的 job。
        //
        // 为什么需要：探针实测 **job 内进程 spawn 的后代默认不在 job 内**
        // （cmd 在 job 内，它 start 的孙进程在 job 关闭后仍活着）⇒ 光 assign
        // 内核自己不够，必须逐个把该进的拉进来。
        //
        // 「不该进的」（用户的浏览器 / npm install 中途）**不调本 API** ⇒ 天然
        // 不在 job 内（探针结论）⇒ 不需要 `ephemeral` 词表项。
        //
        // `role` 而非 `kind`：壳侧 `kind` 已被 `InstallKind`（安装目标，前端
        // 契约冻结）与 telemetry `kind`（事件类型）占用，再造一个 kind 词表
        // 会撞名。`role` 是壳侧既有词表（端口角色 `guard-mgmt`），此处是
        // **进程角色**（不同面：`ports.json` vs 本入参），词表值不撞。
        //
        // ⚠️ `role` **可选、缺省 `managed`**：内核侧 `pm-client.js:124-128` 的
        //    `keepAlive(pid)` 只发 `{ pid }`，且 `:122-123` 有明确设计声明：
        //      「内核只说『这个子进程请壳看住』，不说它是什么业务角色——
        //        『受管对象』这个概念只存在于壳侧（进程所有权的持有方）」。
        //    ⇒ 若 role 必填，现有 6 个调用方（`frp.js:132` / `daemons/process.js:142` /
        //      `main/process.js:110` / `portable.js:93` / `instance/lifecycle.js:93`）
        //      会全部吃到 400 ⇒ 壳一上线就断内核的看护链。
        //    ⇒ 词表只有 `managed` 一个值，缺省即它 ⇒ 「可选」不放松任何约束。
        //
        // 词表单值 `managed`：壳只决定「进不进 job」，区分是内核自己的事。
        ("POST", "/pm/keep-alive") => {
            // pid 缺失/非数字 ⇒ 真·参数问题（400）。
            let Some(pid) = json.get("pid").and_then(|v| v.as_u64()).map(|p| p as u32) else {
                return Ok(reply(StatusCode::BAD_REQUEST, "keep-alive: pid 缺失或不是数字"));
            };
            // role 可选；带了就必须是 managed（真·参数问题才 400）。
            let role = json.get("role").and_then(|v| v.as_str()).unwrap_or("managed");
            if role != "managed" {
                return Ok(reply(StatusCode::BAD_REQUEST, "keep-alive: role 必须是 managed"));
            }
            // FA-20 第一级：内核经 `keepAlive(pid, id)` 自报「这个 pid 是谁」。
            //
            // 为什么必须收：此前本端点只把 pid assign 进 job 就丢了 ⇒ 进程表的
            // `core` 行永远记着**入口 pid / 壳自己**（`guard-mgmt.json` 的 pid 是
            // `std::process::id()`，而 `live_contract_owner():34-35` 恒真）⇒
            // `shutdown_all` 按那个 pid 去杀 ⇒ 杀的是已死的进程，而真内核只活在
            // job 里。本机实测：壳账本 `kill_attempt` 记 972/8396，而真进程是
            // guard=7348 / daemon=7160 —— **两套完全不同的进程**。
            //
            // `id` 可选：老版本内核不带它 ⇒ 不带时走原来的「只 assign」路径。
            let id = json.get("id").and_then(|v| v.as_str());
            if id == Some("core") {
                // 只处理 core 行（第一级）⇒ 用窄方法 `update_pid`（只设 pid）。
                //
                // **不用 `adopt_spawned`**：它改 7 个字段，其中两个致错——
                // `spawn_cmd` 可能被 `core_desc()` 的空 Vec 覆盖（内核永久失自愈）、
                // `phase` 被重置成 Starting（`already` 判据那一拍变 false ⇒ 可能重复
                // 拉起内核，而那是 architect T-1 明令禁止的）。详见 `update_pid` 的注释。
                let ok = state.update_pid("core", pid);
                crate::telemetry::event::info(
                    if ok { "mgmt.core_pid_updated" } else { "mgmt.core_pid_update_missed" },
                    "process_manager",
                    serde_json::json!({
                        "pid": pid, "via": "keep-alive",
                        // miss 的含义：进程表里还没有 core 行 ⇒ 内核比壳先报
                        // （时序问题，不是错误）⇒ 下一次 keep-alive 会补上。
                        "found": ok
                    }),
                );
            } else if id == Some("dsh-main") {
                // S-7b 第二级第一项：**DSH 主实例也要进 job**。
                //
                // 用户裁（原话）：「这是一个完整的接管逻辑，当我们检测到在我们之前
                // 系统内存在 dsh 的时候，我们就应该给它全面做接管。接管后他应该按照
                // 我们的约束管理，而不是再遵循他原有的管理逻辑。」
                //
                // 而 architect 核到的机制真因：内核侧 `_adopt`（`process.js:225-252`）
                // 置 `observedOnly=false` ⇒ DSH **已参与** `stopProcess` 链（受管）；
                // 而 `_adoptObserved`（`:205-223`）置 `true` ⇒ 观测未受管。
                // 7580 走 `_adopt`（`controller.js:132-134` 的 `STOPPED` + `portUp ⇒ adopt()`）
                // ⇒ **内核侧已当它受管** ⇒ 而壳侧 job 不覆盖 ⇒ 壳退时它不停
                // ⇒ **两侧不同步**（S-7b）。
                //
                // core-engineer 已把 `main/process.js:112` 的 id 从 `'core'` 改成
                // `'dsh-main'`（它核到「共用一个 id 会让后写覆盖前写」）⇒ 本处认它。
                //
                // 本件**只做 assign 进 job**（那是用户要的「接管」），**不建进程表行**：
                // DSH 行的 desc 归层 0（`'dsh-main'` 行 + `Priority::Dsh` + heal_burst
                // 加臂），而 `assign_to_job` 不需要进程表有那一行 ⇒ 故本件不依赖层 0。
                //
                // ⚠️ 幂等：DSH 每轮被认领都会报一次 ⇒ `assign_to_job` 对已 assign 的
                //    进程幂等 ⇒ 重复调无害。
                //
                // 层 0：若内核已用 `/pm/register {id:'dsh-main', spawn_cmd, priority}`
                // 自报建行 ⇒ 这里一并更新它的 pid（窄方法，只设 pid）。
                //   ⇒ 壳**不造** DSH 的 desc/spawn_cmd：那是内核的编排对象（它的
                //     `config.command`），壳造一份就是「壳猜内核的事实」⇒ 与
                //     「发现只做一次（内核）」冲突。
                //   ⇒ 所以本处只认 id + 给 Priority（`parse_priority` 已认
                //     `"dsh-main"`/`"dsh"`）+ 在行已存在时更新 pid。
                //
                // W-2-2（architect 裁）：**身份冲突 ⇒ 拒；核不了 ⇒ 宽松 + 留痕**。
                // 两者是两件事，压成一个动作就会误拒旧内核或放过真冲突：
                //   · 行不存在 / 行存在但无 pid ⇒ **核不了** ⇒ 照常 update + assign，
                //     只记 `dsh_main_row_missing`（那正是「缺信息」的形态）；
                //   · 行存在且有 pid，且与本次报的**不同** ⇒ **身份冲突**
                //     （那个行声明过的不是这个 pid）⇒ 拒（不 update、不 assign），
                //     记 `dsh_main_pid_conflict` 并返 409。
                //     ⇒ 而那正是 pid 复用洞（`assign_to_job` 假阳性 ⇒ 壳退时
                //       误杀无关进程）的对策：声明与上报不一致 ⇒ 不猜，拒。
                let declared = state.pid_of("dsh-main");
                if let Some(d) = declared {
                    if d != pid {
                        crate::telemetry::event::error(
                            "mgmt.dsh_main_pid_conflict",
                            "process_manager",
                            serde_json::json!({
                                "pid": pid,
                                "declaredPid": d,
                                "reason": "register 声明的 pid 与 keep-alive 上报的不一致 ⇒ 身份冲突 ⇒ 拒（W-2-2）",
                                "hint": "可能 pid 已复用（原进程退出而 pid 被新进程占用）⇒ 壳拒绝把一个来路不明的 pid 拉进 job（T-1：绝不允许杀非本产品对象）"
                            }),
                        );
                        return Ok(reply(StatusCode::CONFLICT, "keep-alive: pid 与 register 声明的不一致（身份冲突）"));
                    }
                }
                let ok = state.update_pid("dsh-main", pid);
                if !ok {
                    // 行还没建（内核没 register 或还没到）⇒ 不是错误：下一次
                    // keep-alive 会补上。而 job assign 在下面统一做，不受影响。
                    crate::telemetry::event::info(
                        "mgmt.dsh_main_row_missing",
                        "process_manager",
                        serde_json::json!({
                            "pid": pid,
                            "reason": "进程表无 dsh-main 行 ⇒ 内核尚未经 /pm/register 自报；job assign 不受影响"
                        }),
                    );
                }
                crate::telemetry::event::info(
                    "mgmt.dsh_main_adopted",
                    "process_manager",
                    serde_json::json!({
                        "pid": pid,
                        "reason": "用户裁：宽认领 + 全面接管 ⇒ DSH 主实例进 job（壳退时随全链停）",
                        "tableRow": if ok { "已建且 pid 已更新" } else { "未建（等内核 /pm/register）" }
                    }),
                );
            } else if let Some(other) = id {
                // 其他 id（router/lan/frpc/sandbox）**忽略 + info，不返 400**：
                // 第一级没有那些 desc ⇒ 返 400 会让内核以为上报失败 ⇒ pm_request_failed
                // 一类事件误报。而「壳不认识这个 id」不是调用方的错（可能是版本不一致）
                // ⇒ 与 role 缺省 managed 同一条：不要求调用方说壳已经知道的话。
                crate::telemetry::event::info(
                    "mgmt.keep_alive_unknown_id",
                    "process_manager",
                    serde_json::json!({ "pid": pid, "id": other, "reason": "第一级只处理 core；其余 id 已 assign 进 job 但未登记进程表" }),
                );
            }
            // job 未建成 ⇒ 两种可能，必须分开：
            //   · Windows 上建失败（CreateJobObjectW/SetInformationJobObject 失败）
            //     ⇒ **壳自身缺陷**，不能让调用方以为 assign 成功了；
            //   · 非 Windows 上「无 job 概念」（Unix 侧是件 B 的 PR_SET_PDEATHSIG）
            //     ⇒ 平台不支持，不是缺陷。若也返 500，等于每次调用都报假故障。
            //
            // 用 match 而非 let-else：本机无 cargo，let-else 的 else 块分号/ diverging
            // 要求曾在 CI 上制造 `expected ;, found if`（c73f241e 四平台全红），
            // 而 match 的臂语义无歧义。
            let job = match crate::bounded::ensure_kill_on_close_job() {
                Some(j) => j,
                None => {
                    if cfg!(windows) {
                        crate::telemetry::event::error(
                            "mgmt.job_unavailable",
                            "process_manager",
                            serde_json::json!({ "pid": pid, "reason": "job 未建成（CreateJobObjectW/SetInformationJobObject 失败）" }),
                        );
                        return Ok(reply(StatusCode::INTERNAL_SERVER_ERROR, "keep-alive: job 未建成（壳自身缺陷）"));
                    }
                    crate::telemetry::event::info(
                        "mgmt.job_unsupported",
                        "process_manager",
                        serde_json::json!({ "pid": pid, "reason": "本平台无 job 概念（Unix 侧归件 B 的 PR_SET_PDEATHSIG）" }),
                    );
                    return Ok(reply(StatusCode::OK, "ok (job unsupported on this platform)"));
                }
            };
            if !crate::bounded::assign_to_job(job, pid) {
                // S-7b 真失败（field-acceptance 在 1.0.45 全套按时间窗拉全序列抓到）：
                //   DSH 7580 的 assign 被 OS 拒绝，而此前留痕只有「失败」没有**为什么**
                //   ⇒ 无从判是「跨 session」「已在他 job 内」还是「权限」。
                //
                // ⚠️ **必须先取 `GetLastError` 再判活**：`pid_alive` 自己会调
                //    `OpenProcess` ⇒ 那会覆盖线程的 last-error 单槽 ⇒ 顺序反了
                //    拿到的就是 `pid_alive` 的错误码而不是 `AssignProcessToJobObject` 的。
                let err = crate::bounded::last_error();
                let alive = crate::bounded::pid_alive(pid);
                if alive {
                    // 常见成因对照（按 Win32 错误码）：壳只报码与可能含义，不猜是哪一个。
                    let hint = match err {
                        5 => "ERROR_ACCESS_DENIED：对该进程无权 assign ⇒ 可能跨 session/跨用户，或它已在另一个 job 内",
                        87 => "ERROR_INVALID_PARAMETER：job handle 或 pid 无效",
                        6 => "ERROR_INVALID_HANDLE：job handle 失效",
                        _ => "见 Win32 错误码表",
                    };
                    crate::telemetry::event::error(
                        "mgmt.job_assign_failed",
                        "process_manager",
                        serde_json::json!({
                            "pid": pid,
                            "reason": "AssignProcessToJobObject 失败",
                            "win32Error": err,
                            "accessDenied": err == crate::bounded::ERROR_ACCESS_DENIED,
                            "hint": hint,
                            // S-7b 的现场：DSH 7580 的父是用户桌面的「启动DSH.cmd」
                            // ⇒ 不在壳进程树内（树是 2376 → 8352 → 5516）⇒
                            //   而 field-acceptance 已排除「已在他 job 内」与「已死」
                            //   ⇒ 所以这个码是判「跨 session」还是「权限」的唯一输入。
                            "note": "DSH 认领路径：父进程不在壳进程树内 ⇒ 拿码后才能定修法"
                        }),
                    );
                    return Ok(reply(StatusCode::INTERNAL_SERVER_ERROR, "keep-alive: assign 失败"));
                }
                crate::telemetry::event::info(
                    "mgmt.job_assign_skipped",
                    "process_manager",
                    serde_json::json!({ "pid": pid, "reason": "pid 非活进程（调用方时序问题，无需 assign）" }),
                );
                return Ok(reply(StatusCode::OK, "ok (pid not alive, skipped)"));
            }
            crate::telemetry::event::info(
                "mgmt.job_assigned",
                "process_manager",
                serde_json::json!({ "pid": pid, "role": role }),
            );
            Ok(reply(StatusCode::OK, "ok"))
        }
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

/// 进程表的对外读口。**字段裁剪是刻意的**：
///
/// `WorkloadState` 里有 `spawn_cmd`（含内核可执行完整路径）与 `env`（可能带
/// 数据目录/令牌），这些不暴露给读口 —— 排障要回答的是「内核在不在、什么相位、
/// 壳拉起的还是认领的、上次怎么死的」，不是「它的命令行是什么」。
/// 真要 spawn_cmd 的场景（复现一次拉起）走 CLI，不走网络读口。
///
/// `mgmtOwner` 一并给出：它回答「这个端点本身还有没有 owner」，
/// 与 `pm_status` 命令同一判据（读契约 pid + pid_alive）。
fn status_json(state: &ProcessManager) -> String {
    let workloads = {
        let s = state.states.lock().unwrap_or_else(|e| e.into_inner());
        let v: Vec<serde_json::Value> = s
            .values()
            .map(|st| {
                serde_json::json!({
                    "id": st.id,
                    "phase": format!("{:?}", st.phase),
                    "desired": format!("{:?}", st.desired),
                    "pid": st.pid,
                    // 壳拉起的（false）与认领的（true）必须可分：双守卫并存时
                    // 两者的处置完全不同，而这个区别此前只存在于内存里。
                    "adopted": st.adopted,
                    "healFailures": st.heal_failures,
                    "lastWill": st.last_will.as_ref().map(|w| serde_json::json!({
                        "code": w.code, "signal": w.signal, "startupFailure": w.startup_failure
                    })),
                })
            })
            .collect();
        v
    };
    let owner = {
        let path = crate::env::supervisor_dir().join("guard-mgmt.json");
        let text = std::fs::read_to_string(&path).ok();
        let parsed: Option<serde_json::Value> = text.as_deref().and_then(|t| serde_json::from_str(t).ok());
        parsed.and_then(|v| {
            let pid = v.get("pid")?.as_u64()? as u32;
            Some(serde_json::json!({
                "pid": pid,
                "alive": crate::bounded::pid_alive(pid),
                "port": v.get("port").and_then(|p| p.as_u64()),
            }))
        })
    };
    serde_json::to_string(&serde_json::json!({
        "schema": 1,
        "workloads": workloads,
        "mgmtOwner": owner,
    }))
    .unwrap_or_else(|_| "{\"schema\":1,\"error\":\"serialize failed\"}".to_string())
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

/// 内核自报的 priority 字符串 → 枚举。未带 priority 的一律按最低优先级入表。
///
/// `"dsh-main"` / `"dsh"` 都认：前者是 `/pm/keep-alive` 的 id（core 侧
/// `main/process.js:112` 用它），后者是短形 ⇒ 认两者，不要求内核说壳已经知道的话。
fn parse_priority(s: Option<&str>) -> state_machine::Priority {
    match s {
        Some("core") => state_machine::Priority::Core,
        Some("dsh-main") | Some("dsh") => state_machine::Priority::Dsh,
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
