//! 事件读口。壳侧此前**零读口**（shell.log 只写不读，诊断全靠前端一行内存字符串，
//! 刷新即清零）。这里提供增量读与导出，供诊断面板与 IPC 使用。
//!
//! limit 一律钳制：内核 events.js 对此有明确事故背景 —— watermark 重置那一拍
//! 会把整个事件文件读进内存同步阻塞事件循环数百毫秒。壳侧照搬该约束。

use super::{shell_events_path, Event, Level};

const MAX_LIMIT: usize = 5000;

/// 读 seq 大于 after 的事件，最多 limit 条。
///
/// 跨轮转时会一并扫备份文件（`after < rotatedSeq` 即表示备份里有尚未读到的部分）。
pub fn read_since(after: u64, limit: usize) -> Vec<Event> {
    let limit = limit.clamp(1, MAX_LIMIT);
    let mut out = Vec::new();
    let rotated = super::sink::rotated_seq();
    if after < rotated {
        for e in scan(&backup_path(), after, limit) {
            out.push(e);
        }
    }
    for e in scan(&shell_events_path(), after, limit.saturating_sub(out.len())) {
        out.push(e);
    }
    out
}

/// 取末尾 limit 条事件。
pub fn tail(limit: usize) -> Vec<Event> {
    let limit = limit.clamp(1, MAX_LIMIT);
    let cur = super::sink::current_seq();
    let from = cur.saturating_sub(limit as u64);
    read_since(from, limit)
}

/// 按级别过滤。
pub fn by_level(min: Level) -> Vec<Event> {
    tail(MAX_LIMIT)
        .into_iter()
        .filter(|e| Level::parse(&e.level) >= min)
        .collect()
}

/// 导出为纯文本（诊断面板「复制」用）。
pub fn export_text(limit: usize) -> String {
    tail(limit)
        .iter()
        .map(|e| {
            format!("[{}] {:5} {}{} {}", e.ts, e.level, e.kind, scope_suffix(e), e.data)
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn scope_suffix(e: &Event) -> String {
    if e.producer.scope.is_empty() {
        String::new()
    } else {
        format!("[{}]", e.producer.scope)
    }
}

fn backup_path() -> std::path::PathBuf {
    let mut p = shell_events_path().as_os_str().to_os_string();
    p.push(".1");
    std::path::PathBuf::from(p)
}

fn scan(file: &std::path::Path, after: u64, limit: usize) -> Vec<Event> {
    let Ok(text) = std::fs::read_to_string(file) else { return Vec::new() };
    let mut out = Vec::new();
    for line in text.lines() {
        if out.len() >= limit {
            break;
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(ev) = serde_json::from_str::<Event>(trimmed) else { continue };
        if ev.seq > after {
            out.push(ev);
        }
    }
    out
}