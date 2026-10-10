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

pub async fn run(state: Arc<ProcessManager>) {
    let listener = match tokio::net::TcpListener::bind("127.0.0.1:0").await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("[mgmt] bind 127.0.0.1:0 失败: {e}");
            return;
        }
    };
    let port = listener.local_addr().map(|a| a.port()).unwrap_or(0);
    
    if let Ok(mut guard) = state.ports.lock() {
        let _ = guard.register_sole("guard-mgmt", port);
        
        guard.persist();
    }
    eprintln!("[mgmt] guard-mgmt 监听 127.0.0.1:{port}");
    
    
    export_port(port);
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
                eprintln!("[mgmt] 连接错误: {e}");
            }
        });
    }
}

fn export_port(port: u16) {
    let path = crate::env::supervisor_dir().join("guard-mgmt.json");
    let body = match serde_json::to_string_pretty(&serde_json::json!({
        "schema": 1,
        "role": "guard-mgmt",
        "host": "127.0.0.1",
        "port": port,
        "pid": std::process::id(),
        "at": std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0),
    })) {
        Ok(b) => b,
        Err(e) => { eprintln!("[mgmt] 端口契约序列化失败: {e}"); return; }
    };
    if let Some(dir) = path.parent() {
        if let Err(e) = std::fs::create_dir_all(dir) {
            eprintln!("[mgmt] 端口契约目录创建失败: {e}");
            return;
        }
    }
    let tmp = path.with_extension("json.tmp");
    if let Err(e) = std::fs::write(&tmp, body + "\n") {
        eprintln!("[mgmt] 端口契约写入失败: {e}");
        return;
    }
    if let Err(e) = std::fs::rename(&tmp, &path) {
        eprintln!("[mgmt] 端口契约提交失败: {e}");
    }
}

async fn handle(
    state: Arc<ProcessManager>,
    req: Request<Incoming>,
) -> Result<Response<Full<Bytes>>, Infallible> {
    let method = req.method().clone();
    let path = req.uri().path().to_string();
    
    let body = match req.into_body().collect().await {
        Ok(c) => c.to_bytes(),
        Err(_) => Bytes::new(),
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
                let startup_failure = json.get("startup_failure").and_then(|v| v.as_bool()).unwrap_or(false);
                state.record_exit(
                    id,
                    state_machine::LastWill {
                        code,
                        signal,
                        at: std::time::Instant::now(),
                    },
                    startup_failure,
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
        
        ("POST", "/pm/reset-backoff") => {
            if let Some(id) = json.get("id").and_then(|v| v.as_str()) {
                state.reset_backoff(id);
            }
            Ok(reply(StatusCode::OK, "ok"))
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
