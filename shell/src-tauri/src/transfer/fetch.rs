//! 取件的实际执行：逐源尝试 -> 完整性判定 -> 摘要校验 -> 落到暂存区。
//!
//! 顺序刻意固定：**先比对大小，再校验摘要**。
//! 一个被截断的包不必等摘要算完才发现不对 —— 那会白算一遍完整哈希。
//!
//! 三处细节照抄自既有可用实现（node.rs::http_get_bytes_progress），不重新发明：
//!   1. total 优先取响应头的 Content-Length，其次用调用方给的期望值；
//!   2. 按 total 预分配缓冲区，避免大包反复扩容；
//!   3. 上报按进度步长节流（total/100），否则每个 64KB 块都 emit 一次
//!      会把 UI 事件通道打满 —— 这正是该实现里 report_every 的由来。

use super::{source::Candidate, Fetched, Request};
use std::io::Read;

pub fn run(
    urls: &[Candidate],
    req: &Request,
    on_progress: &dyn Fn(u64, Option<u64>),
) -> Result<Fetched, String> {
    if let Some(p) = req.dest.parent() {
        std::fs::create_dir_all(p).map_err(|e| format!("创建暂存目录失败: {}", e))?;
    }
    let mut last: Option<String> = None;
    for (idx, cand) in urls.iter().enumerate() {
        if idx == 0 {
            on_progress(0, req.expect_size);
        }
        match try_one(cand, req, on_progress) {
            Ok(fetched) => return Ok(fetched),
            Err(e) => {
                crate::telemetry::event::warn("transfer.source_unavailable", "transfer", serde_json::json!({ "source": cand.label, "error": e.to_string() }));
                last = Some(e);
            }
        }
    }
    Err(format!(
        "全部 {} 个源均未取得可用产物（最后一条：{}）",
        urls.len(),
        last.unwrap_or_else(|| "无详情".to_string())
    ))
}

fn try_one(
    cand: &Candidate,
    req: &Request,
    on_progress: &dyn Fn(u64, Option<u64>),
) -> Result<Fetched, String> {
    let resp = crate::mirror::agent()
        .get(&cand.url)
        .set("User-Agent", ua())
        .timeout(req.timeout)
        .call()
        .map_err(|e| format!("下载失败 {}: {}", cand.url, e))?;
    let total = resp
        .header("content-length")
        .and_then(|v| v.trim().parse::<u64>().ok())
        .or(req.expect_size)
        .filter(|t| *t > 0);
    let mut data: Vec<u8> = Vec::with_capacity(total.unwrap_or(0).min(64 * 1024 * 1024) as usize);
    let cap = total.map(|t| t.saturating_add(1024 * 1024)).unwrap_or(512 * 1024 * 1024);
    let mut seen = 0u64;
    let report_every = total.map(|t| (t / 100).max(1)).unwrap_or(512 * 1024);
    let mut next_report = 0u64;
    {
        let mut reader = resp.into_reader();
        let mut chunk = [0u8; 64 * 1024];
        loop {
            let n = reader.read(&mut chunk).map_err(|e| format!("读取响应体中断: {}", e))?;
            if n == 0 {
                break;
            }
            data.extend_from_slice(&chunk[..n]);
            seen += n as u64;
            if seen > cap {
                return Err(format!("取回超出上限（{} 字节）", cap));
            }
            if seen >= next_report {
                on_progress(seen, total);
                next_report = seen + report_every;
            }
        }
    }
    on_progress(seen, total);
    if data.is_empty() {
        return Err("响应体为空".to_string());
    }
    if let Some(want) = req.expect_size {
        if seen != want {
            return Err(format!("取回不完整：声明 {} 字节，实得 {} 字节", want, seen));
        }
    }
    if let Some(v) = req.verify.as_ref() {
        v.check(&data)?;
    }
    std::fs::write(&req.dest, &data).map_err(|e| format!("写入暂存文件失败: {}", e))?;
    Ok(Fetched {
        path: req.dest.clone(),
        bytes: seen,
        from_cache: false,
        source: Some(cand.label.clone()),
    })
}
/// 取件请求的 UA。带上产品名便于各镜像按来源统计，也便于服务端识别。
fn ua() -> &'static str {
    concat!("lobox-shell/", env!("CARGO_PKG_VERSION"))
}