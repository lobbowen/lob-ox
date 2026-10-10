//! 机箱 loopback 管理端点（Y 模式：底座持有的真相，由内核子进程单向上报）。
//!
//! 拓扑：壳（父）经 spawn_daemon 拉起内核（子）；内核无反向 invoke 壳的通道，
//! 故底座在此暴露 127.0.0.1 的极简 HTTP 端点（端口受 PortAuthority 唯一分配，
//! 登记为 guard-mgmt），内核经 HTTP POST 上报 register / set-desired / on-phase /
//! record-exit / request-restart。浏览器策略天然封死跨源；底座持有唯一真相。

use std::convert::Infallible;
use std::sync::Arc;

use hyper::body::to_bytes;
use hyper::body::Bytes;
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::TokioIo;

use crate::process_manager::state_machine;
use crate::process_manager::ProcessManager;

pub async fn run(state: Arc<ProcessManager>) {
    let listener = match tokio::net::TcpListener::bind("127.0.0.1:0").await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("[mgmt] bind 127.0.0.1:0 失败: {e}");
            return;
        }
    };
    let port = listener.local_addr().map(|a| a.port()).unwrap_or(0);
    // 端口受机箱权威分配：OS 分配后回写（等效 allocate 但避开竞争窗口）。
    if let Ok(mut guard) = state.ports.lock() {
        let _ = guard.register_sole("guard-mgmt", port);
    }
    eprintln!("[mgmt] guard-mgmt 监听 127.0.0.1:{port}");
    loop {
        let (stream, _addr) = match listener.accept().await {
            Ok(x) => x,
            Err(_) => continue,
        };
        let io = TokioIo::new(stream);
        let st = state.clone();
        tokio::spawn(async move {
            let svc = service_fn(move |req: Request<hyper::body::Incoming>| {
                let st = st.clone();
                async move { handle(st, req).await }
            });
            if let Err(e) = http1::Builder::new().serve_connection(io, svc).await {
                eprintln!("[mgmt] 连接错误: {e}");
            }
        });
    }
}

async fn handle(
    state: Arc<ProcessManager>,
    req: Request<hyper::body::Incoming>,
) -> Result<Response<Bytes>, Infallible> {
    let method = req.method().clone();
    let path = req.uri().path().to_string();
    let body = match to_bytes(req.into_body()).await {
        Ok(b) => b,
        Err(_) => return Ok(reply(StatusCode::BAD_REQUEST, "read body")),
    };
    let json: serde_json::Value = if body.is_empty() {
        serde_json::Value::Null
    } else {
        match serde_json::from_slice::<serde_json::Value>(&body) {
            Ok(j) => j,
            Err(_) => return Ok(reply(StatusCode::BAD_REQUEST, "bad json")),
        }
    };
    match (method.as_str(), path.as_str()) {
        ("POST", "/pm/register") => {
            if let Some(desc) = parse_desc(&json) {
                state.register_workload(desc);
            }
            Ok(reply(StatusCode::OK, "ok"))
        }
        ("POST", "/pm/set-desired") => {
            if let Some(id) = json.get("id").and_then(|v| v.as_str()) {
                if let Some(d) = json
                    .get("desired")
                    .and_then(|v| v.as_str())
                    .and_then(parse_desired)
                {
                    state.set_desired(id, d);
                }
            }
            Ok(reply(StatusCode::OK, "ok"))
        }
        ("POST", "/pm/on-phase") => {
            if let Some(id) = json.get("id").and_then(|v| v.as_str()) {
                if let Some(p) = json.get("phase").and_then(|v| v.as_str()).and_then(parse_phase) {
                    state.on_phase(id, p);
                }
            }
            Ok(reply(StatusCode::OK, "ok"))
        }
        ("POST", "/pm/record-exit") => {
            if let Some(id) = json.get("id").and_then(|v| v.as_str()) {
                let code = json.get("code").and_then(|v| v.as_i64()).map(|x| x as i32);
                let signal = json.get("signal").and_then(|v| v.as_str()).map(|s| s.to_string());
                state.record_exit(
                    id,
                    state_machine::LastWill {
                        code,
                        signal,
                        at: std::time::Instant::now(),
                    },
                );
            }
            Ok(reply(StatusCode::OK, "ok"))
        }
        ("POST", "/pm/request-restart") => {
            if let Some(id) = json.get("id").and_then(|v| v.as_str()) {
                state.request_restart(id);
            }
            Ok(reply(StatusCode::OK, "ok"))
        }
        _ => Ok(reply(StatusCode::NOT_FOUND, "not found")),
    }
}

fn reply(status: StatusCode, msg: &str) -> Response<Bytes> {
    Response::builder()
        .status(status)
        .body(Bytes::from(msg.as_bytes().to_vec()))
        .unwrap_or_else(|_| Response::new(Bytes::from_static(b"err")))
}

fn parse_desc(v: &serde_json::Value) -> Option<state_machine::WorkloadDesc> {
    let id = v.get("id")?.as_str()?.to_string();
    let spawn_cmd = v
        .get("spawn_cmd")
        .and_then(|a| a.as_array())
        .map(|arr| arr.iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect())
        .unwrap_or_default();
    let restart_window_ms = v.get("restart_window_ms").and_then(|x| x.as_u64()).unwrap_or(60_000);
    let restart_burst = v.get("restart_burst").and_then(|x| x.as_u64()).unwrap_or(5) as u32;
    Some(state_machine::WorkloadDesc {
        id,
        spawn_cmd,
        restart_window_ms,
        restart_burst,
    })
}

fn parse_phase(s: &str) -> Option<state_machine::Phase> {
    Some(match s {
        "stopped" => state_machine::Phase::Stopped,
        "starting" => state_machine::Phase::Starting,
        "running" => state_machine::Phase::Running,
        "draining" => state_machine::Phase::Draining,
        "failed" => state_machine::Phase::Failed,
        "restarting" => state_machine::Phase::Restarting,
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
