//! 跨进程契约文件的原子提交：tmp 写盘 + rename。
//! 统一收口此前的 7 处各自实现——它们的失败清理策略并不一致
//!（mirror.rs / update.rs 在 rename 失败时泄漏 .tmp，另几处会清理）。
//! 临时名必须**独占**：早先的 with_extension("json.tmp") 让同名目标的并发写碰撞
//!（前一个写者 rename 走之后，后一个 rename 拿到的是别人的内容或直接失败）。

use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

/// 进程内单调计数：同进程内并发写同一目标也不会撞名。
static SEQ: AtomicU64 = AtomicU64::new(0);

/// 写入的三种结局。「写成功但权限未设」不能塌缩进另两种：
/// 前者要调用方知道文件已落盘、后者要让调用方知道权限目标没达到。
/// 不提供 `is_*` 之类的布尔判据——那会把三态塌回两态，
/// 让调用方可以忽略第三种结局（便利出口不是中性的）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    Written,
    PermissionNotSet { mode: &'static str, reason: String },
}

fn tmp_path_for(path: &Path) -> std::path::PathBuf {
    let seq = SEQ.fetch_add(1, Ordering::Relaxed);
    let name = path.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    path.with_file_name(format!("{}.tmp-{}-{}", name, std::process::id(), seq))
}

fn ensure_parent(path: &Path) -> Result<(), String> {
    match path.parent() {
        Some(parent) if !parent.as_os_str().is_empty() => {
            std::fs::create_dir_all(parent).map_err(|e| format!("创建目录 {} 失败: {}", parent.display(), e))
        }
        _ => Ok(()),
    }
}

pub fn write(path: &Path, body: &str) -> Result<(), String> {
    ensure_parent(path)?;
    let tmp = tmp_path_for(path);
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

/// 原子提交 + 属主可读收口。tmp 与命名规则复用 `write` 的同一套，
/// 不复制一份——临时名独占与统一收口是本模块的两条既有不变式。
///
/// 三态语义，且**「权限无法收口」不得阻止「文件落盘」**——两者必须解耦：
/// - `Err(String)`：字节没落盘（parent / tmp-write / rename 失败），调用方按「没写进去」处置；
/// - `Ok(Outcome::Written)`：落盘 + 权限已收口；
/// - `Ok(Outcome::PermissionNotSet)`：**落盘了**，但权限没收口（含「本平台无 POSIX 权限位」）。
///
/// 把 chmod 失败升级成写失败会让「权限没设上」变成「功能不可用」——
/// Windows 上即表现为管理端点直接失效，那是比权限敞开更严重的回退。
///
/// mode 由调用方显式给出：它才知道自己在什么平台、写给谁读。
/// umask 会掩掉创建时的 mode，故创建后仍 chmod 一次（对侧范式：
/// `core/src/platform/util/fs.js` 的 writeDurable 也是 mode + chmod 双路）。
pub fn write_private(path: &Path, body: &str, mode: u32) -> Result<Outcome, String> {
    ensure_parent(path)?;
    let tmp = tmp_path_for(path);
    if let Err(e) = write_with_mode(&tmp, body, mode) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }
    let mut permission_err: Option<String> = None;
    if let Err(e) = chmod(&tmp, mode) {
        permission_err = Some(e);
    }
    if let Err(e) = std::fs::rename(&tmp, path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("提交 {} 失败: {}", path.display(), e));
    }
    match (chmod(path, mode), permission_err) {
        (Ok(()), None) => Ok(Outcome::Written),
        (Err(e), None) => Ok(Outcome::PermissionNotSet { mode: "final-chmod", reason: e }),
        (_, Some(e)) => Ok(Outcome::PermissionNotSet { mode: "tmp-chmod", reason: e }),
    }
}

#[cfg(unix)]
fn write_with_mode(path: &Path, body: &str, mode: u32) -> Result<(), String> {
    use std::os::unix::fs::OpenOptionsExt;
    std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(mode)
        .open(path)
        .map_err(|e| format!("创建临时文件 {} 失败: {}", path.display(), e))
        .and_then(|mut f| {
            use std::io::Write;
            f.write_all(body.as_bytes())
                .map_err(|e| format!("写临时文件 {} 失败: {}", path.display(), e))
        })
}

#[cfg(not(unix))]
fn write_with_mode(path: &Path, body: &str, _mode: u32) -> Result<(), String> {
    std::fs::write(path, body.as_bytes()).map_err(|e| format!("写临时文件 {} 失败: {}", path.display(), e))
}

#[cfg(unix)]
fn chmod(path: &Path, mode: u32) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode))
        .map_err(|e| format!("设置权限 {} 失败: {}", path.display(), e))
}

/// 非 Unix 平台没有 POSIX 权限位，chmod 是空操作。
/// 这里返回 Ok 会让 `write_private` 在 Windows 上永远报 Written——
/// 那是把「权限未设」伪装成「已收口」。故返回 Err 让调用点看到
/// 「这个平台无法用 mode 收口」这一事实，由它决定降级路径。
#[cfg(not(unix))]
fn chmod(_path: &Path, _mode: u32) -> Result<(), String> {
    Err("当前平台无 POSIX 权限位，mode 收口不可用".to_string())
}
