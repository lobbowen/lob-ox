//! 跨进程契约文件的原子提交：tmp 写盘 + rename。
//! 统一收口此前的 7 处各自实现——它们的失败清理策略并不一致
//!（mirror.rs / update.rs 在 rename 失败时泄漏 .tmp，另几处会清理）。
//! 临时名必须**独占**：早先的 with_extension("json.tmp") 让同名目标的并发写碰撞
//!（前一个写者 rename 走之后，后一个 rename 拿到的是别人的内容或直接失败）。

use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

/// 进程内单调计数：同进程内并发写同一目标也不会撞名。
static SEQ: AtomicU64 = AtomicU64::new(0);

pub fn write(path: &Path, body: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建目录 {} 失败: {}", parent.display(), e))?;
    }
    let seq = SEQ.fetch_add(1, Ordering::Relaxed);
    let name = path.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let tmp = path.with_file_name(format!("{}.tmp-{}-{}", name, std::process::id(), seq));
    if let Err(e) = std::fs::write(&tmp, body.as_bytes()) {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("写临时文件 {} 失败: {}", tmp.display(), e));
    }
    if let Err(e) = std::fs::rename(&tmp, path) {
        // rename 失败（跨设备/权限/占用）时必须清掉临时文件，否则泄漏。
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("提交 {} 失败: {}", path.display(), e));
    }
    Ok(())
}
