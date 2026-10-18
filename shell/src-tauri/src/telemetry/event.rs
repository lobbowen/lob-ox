//! 事件构造与 ISO 时间戳。

use super::{Event, Level, Producer};

/// 当前时间的 ISO-8601 UTC，与内核 `new Date().toISOString()` 同形。
///
/// 此前壳侧用 Unix 秒（`[1792055101]`），与内核的 ISO 串无法直接排序比对，
/// 跨进程排障时要人工换算。
pub fn now_iso() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0) as i64;
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let (h, mi, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    let (y, mo, d) = civil_from_days(days);
    format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z", y, mo, d, h, mi, s)
}

/// Howard Hinnant 的 civil_from_days。
fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as i64;
    let mo = if mp < 10 { mp + 3 } else { mp - 9 } as i64;
    (if mo <= 2 { y + 1 } else { y }, mo, d)
}

/// 记录一条壳侧事件。这是全壳唯一的记录入口。
pub fn record(kind: &str, level: Level, scope: &str, data: serde_json::Value) {
    let mut ev = Event::new(kind, level, data);
    ev.producer.scope = scope.to_string();
    let seq = super::sink::append(&ev);
    if seq.is_none() {
        // 记录本身失败不能再递归记录（会无限自放大），
        // 退回 stderr 让内核的原始输出通道承担。
        eprintln!("[telemetry] 事件落盘失败 kind={}", kind);
    }
}

/// 便捷入口：info 级。
pub fn info(kind: &str, scope: &str, data: serde_json::Value) {
    record(kind, Level::Info, scope, data)
}

/// 便捷入口：warn 级（功能失效但整体可用）。
pub fn warn(kind: &str, scope: &str, data: serde_json::Value) {
    record(kind, Level::Warn, scope, data)
}

/// 便捷入口：error 级。
pub fn error(kind: &str, scope: &str, data: serde_json::Value) {
    record(kind, Level::Error, scope, data)
}

/// 便捷入口：fatal 级（消费侧应终止流程）。
pub fn fatal(kind: &str, scope: &str, data: serde_json::Value) {
    record(kind, Level::Fatal, scope, data)
}