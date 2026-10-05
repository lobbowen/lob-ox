//! 桌面壳身份与日志：只负责壳自身的身份落盘与日志。identity.json 由壳写，内核只读其中的运行时字段（version / phase / exe / lastSeenAt 等）；内核 domains/shell/watchdog 用 exe 在壳崩溃后把它拉起，故必须保留。

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

pub fn state_dir() -> PathBuf {
    if let Some(p) = test_state_dir_override() {
        return p;
    }
    crate::env::shell_dir()
}

#[cfg(test)]
static TEST_STATE_DIR: std::sync::Mutex<Option<PathBuf>> = std::sync::Mutex::new(None);

#[cfg(test)]
fn test_state_dir_override() -> Option<PathBuf> {
    TEST_STATE_DIR.lock().unwrap_or_else(|e| e.into_inner()).clone()
}

#[cfg(not(test))]
fn test_state_dir_override() -> Option<PathBuf> {
    None
}

fn identity_path() -> PathBuf { state_dir().join("identity.json") }
fn log_path() -> PathBuf { state_dir().join("shell.log") }
/// 守卫子进程的输出落点：`<状态根>/shell/guard.log`；与壳自身的 shell.log 分开以保留「谁说的话」的归属。公开是为了让报错能指名证据在哪。
pub fn guard_log_path() -> PathBuf { state_dir().join("guard.log") }

/// 打开守卫输出日志（追加 + 建目录）。**打不开时返回 None**，由调用方退回 null。这条通道只做「有则记」：它绝不能成为拉起失败的原因。
pub fn guard_log_file() -> Option<std::fs::File> {
    let dir = state_dir();
    let _ = fs::create_dir_all(&dir);
    let p = guard_log_path();
    // 写这个文件的是**子进程**，它不会自己滚动；守卫若陷入崩溃循环，一晚上就能把磁盘写满。超限（512KB）时先截断保留后半部分。
    if let Ok(md) = fs::metadata(&p) {
        if md.len() > 512 * 1024 {
            if let Ok(s) = fs::read_to_string(&p) {
                let n = s.chars().count();
                let keep: String = s.chars().skip(n.saturating_sub(256 * 1024)).collect();
                let _ = fs::write(&p, keep);
            }
        }
    }
    fs::OpenOptions::new().create(true).append(true).open(&p).ok()
}

pub fn log(line: &str) {
    let dir = state_dir();
    let _ = fs::create_dir_all(&dir);
    let p = log_path();
    if let Ok(md) = fs::metadata(&p) {
        if md.len() > 1024 * 1024 {
            if let Ok(s) = fs::read_to_string(&p) {
                let n = s.chars().count();
                let keep: String = s.chars().skip(n.saturating_sub(512 * 1024)).collect();
                let _ = fs::write(&p, keep);
            }
        }
    }
    if let Ok(mut f) = fs::OpenOptions::new().create(true).append(true).open(&p) {
        let _ = writeln!(f, "[{}] {}", now_secs(), line);
    }
}

pub fn install_kind() -> String {
    match tauri::utils::platform::bundle_type() {
        Some(tauri::utils::config::BundleType::Deb) => "deb",
        Some(tauri::utils::config::BundleType::Msi) => "msi",
        Some(tauri::utils::config::BundleType::Nsis) => "nsis",
        Some(tauri::utils::config::BundleType::App) => "app",
        _ => "unknown",
    }
    .to_string()
}

fn has_privilege_channel() -> bool {
    crate::platform::current().has_privilege_channel()
}

pub fn self_update_capable() -> bool {
    match install_kind().as_str() {
        "deb" => has_privilege_channel(),
        "nsis" | "msi" | "app" => true,
        _ => false,
    }
}

fn read_json(p: &Path) -> serde_json::Value {
    fs::read_to_string(p)
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .unwrap_or_else(|| serde_json::json!({}))
}

fn write_json(p: &Path, v: &serde_json::Value) {
    let dir = p.parent().unwrap_or(Path::new("."));
    let _ = fs::create_dir_all(dir);
    let tmp = p.with_extension("json.tmp");
    let body = serde_json::to_string_pretty(v).unwrap_or_default();
    if fs::write(&tmp, body).is_ok() {
        let _ = fs::rename(&tmp, p);
    }
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// 写 identity.json —— 身份文件的唯一写入点。runtime_fields 描述本次调用的运行时上下文；其余字段从现有文件保留。
fn write_identity_for(runtime_fields: &serde_json::Value) -> serde_json::Value {
    let mut v = read_json(&identity_path());
    if !v.is_object() {
        v = serde_json::json!({});
    }
    let map = v.as_object_mut().expect("identity.json must be an object");
    if let Some(rf) = runtime_fields.as_object() {
        for (k, val) in rf {
            map.insert(k.clone(), val.clone());
        }
    }
    let out = serde_json::Value::Object(map.clone());
    write_json(&identity_path(), &out);
    out
}

pub fn init_identity(version: &str) -> serde_json::Value {
    let kind = install_kind();
    let capable = self_update_capable();
    let now = now_secs();
    let runtime = serde_json::json!({
        "version": version,
        "platform": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "installKind": kind,
        "selfUpdateCapable": capable,
        "phase": "boot",
        "pid": std::process::id(),
        "startedAt": now,
        "lastSeenAt": now,
        "exe": crate::platform::self_exe().ok().map(|p| p.display().to_string()),
    });
    let id = write_identity_for(&runtime);
    log(&format!(
        "壳启动 v{} kind={} 可自更新={}",
        version, kind, capable
    ));
    id
}

/// 更新阶段上报（引导页各步骤调用）。
pub fn set_phase(phase: &str) {
    write_identity_for(&serde_json::json!({ "phase": phase }));
    log(&format!("阶段 → {}", phase));
}

pub fn identity_snapshot() -> serde_json::Value {
    read_json(&identity_path())
}

#[cfg(test)]
mod tests {
    use super::*;

    static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    struct Env {
        _g: std::sync::MutexGuard<'static, ()>,
        dir: PathBuf,
    }
    impl Env {
        fn new(tag: &str) -> Self {
            let g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
            let dir = std::env::temp_dir().join(format!("lobox-shell-{}-{}", tag, std::process::id()));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).expect("create temp dir");
            *TEST_STATE_DIR.lock().unwrap_or_else(|e| e.into_inner()) = Some(dir.clone());
            Env { _g: g, dir }
        }
    }
    impl Drop for Env {
        fn drop(&mut self) {
            if let Ok(mut m) = TEST_STATE_DIR.lock() {
                *m = None;
            }
            let _ = fs::remove_dir_all(&self.dir);
        }
    }

    #[test]
    fn t1_runtime_fields_are_written() {
        let env = Env::new("runtime");
        let id = init_identity("1.2.3");
        assert_eq!(id["version"], serde_json::json!("1.2.3"));
        assert_eq!(id["phase"], serde_json::json!("boot"));
        assert!(id.get("exe").is_some(), "exe 必须存在（内核监控依赖）");
        assert!(id.get(concat!("at", "tempt")).is_none(), "不得存在尝试计数");
        assert!(id.get(concat!("pending", "Version")).is_none(), "不得存在待确认版本");
        assert!(env.dir.join("identity.json").exists());
    }

    #[test]
    fn t4_set_phase_preserves_runtime_fields() {
        let _env = Env::new("phase");
        init_identity("1.2.3");
        set_phase("shell-update-check");
        let id = identity_snapshot();
        assert_eq!(id["phase"], serde_json::json!("shell-update-check"));
        assert_eq!(id["version"], serde_json::json!("1.2.3"), "set_phase 不得抹掉 version");
    }
}
