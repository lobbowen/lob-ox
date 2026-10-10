use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

const NODE_PROBE_TIMEOUT: Duration = Duration::from_secs(5);

const NODE_PROBE_TOTAL_BUDGET: Duration = Duration::from_secs(20);

pub fn node_exe() -> &'static str {
    crate::platform::current().node_exe_name()
}

pub fn is_usable_candidate(cand: &Path) -> bool {
    crate::platform::current().is_usable_executable(cand)
}

const PATH_SCAN_BUDGET: Duration = Duration::from_secs(10);

pub fn find_in_path(name: &str) -> Option<PathBuf> {
    let started = Instant::now();
    for dir in path_dirs_local_only() {
        if started.elapsed() >= PATH_SCAN_BUDGET { break; }
        let cand = dir.join(name);
        if is_usable_candidate(&cand) { return Some(cand); }
    }
    None
}

pub fn path_dirs_local_only() -> Vec<PathBuf> {
    let mut out = Vec::new();
    let Some(path) = std::env::var_os("PATH") else { return out };
    for dir in std::env::split_paths(&path) {
        if !is_local_fixed_dir(&dir) { continue; }
        out.push(dir);
    }
    out
}

pub fn is_local_fixed_dir(dir: &Path) -> bool {
    crate::platform::current().is_local_fixed_dir(dir)
}

pub fn recorded_node_path() -> Option<PathBuf> {
    let p = supervisor_dir().join("runtime.json");
    let s = std::fs::read_to_string(&p).ok()?;
    let v: serde_json::Value = serde_json::from_str(&s).ok()?;
    let node = v.get("nodePath").and_then(|x| x.as_str())?;
    if node.is_empty() { return None; }
    let cand = PathBuf::from(node);
    if is_usable_candidate(&cand) { Some(cand) } else { None }
}

pub fn node_version(node: &Path) -> Option<String> {
    use std::process::Stdio;
    let mut cmd = Command::new(node);
    cmd.arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    crate::bounded::prepare(&mut cmd);
    let mut child = cmd.spawn().ok()?;
    let start = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(st)) => break st,
            Ok(None) => {
                if start.elapsed() >= NODE_PROBE_TIMEOUT {
                    crate::bounded::kill_tree(&mut child);
                    let _ = child.wait();
                    return None;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(_) => {
                crate::bounded::kill_tree(&mut child);
                let _ = child.wait();
                return None;
            }
        }
    };
    if !status.success() { return None; }
    let mut s = String::new();
    if let Some(mut out) = child.stdout.take() {
        use std::io::Read;
        let _ = out.read_to_string(&mut s);
    }
    let s = s.trim().to_string();
    if s.is_empty() { None } else { Some(s) }
}

pub fn probe_system_node() -> Option<(PathBuf, String)> {
    crate::nodeprobe::resolve(NODE_PROBE_TOTAL_BUDGET)
}

pub const GLOBAL_BIN_DIRNAME: &str = "bin";
pub const GLOBAL_APP_DIRNAME: &str = "lobox";

pub fn global_install_root() -> PathBuf {
    let base = if cfg!(windows) {
        std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| home().join("AppData").join("Roaming"))
    } else {
        home().join(".local")
    };
    if cfg!(windows) { base.join(GLOBAL_APP_DIRNAME).join(GLOBAL_BIN_DIRNAME) } else { base.join(GLOBAL_BIN_DIRNAME) }
}

pub fn node_install_root() -> PathBuf {
    state_root().join("node")
}

pub fn node_install_target() -> PathBuf {
    global_install_root()
}

pub fn known_install_node_path() -> Option<PathBuf> {
    let p = crate::platform::current().node_bin_after_install();
    if p.is_file() {
        Some(p)
    } else {
        None
    }
}

pub const STATE_ROOT_SCHEMA: u32 = 1;

pub fn state_root() -> PathBuf {
    if let Ok(v) = std::env::var(crate::brand::ENV_STATE_ROOT) {
        if !v.trim().is_empty() {
            return PathBuf::from(v.trim());
        }
    }
    crate::platform::current().state_root_default()
}

pub fn supervisor_dir() -> PathBuf {
    state_root().join(crate::brand::STATE_SUPERVISOR_SUBDIR)
}

pub fn shell_dir() -> PathBuf {
    state_root().join(crate::brand::STATE_SHELL_SUBDIR)
}

pub fn migrate_legacy() {
    let home = home();
    let root = state_root();
    for (from, to) in [
        (
            home.join(crate::brand::LEGACY_HARNESS_DIR).join(crate::brand::STATE_SUPERVISOR_SUBDIR),
            root.join(crate::brand::STATE_SUPERVISOR_SUBDIR),
        ),
        (
            home.join(crate::brand::LEGACY_HARNESS_DIR).join(crate::brand::STATE_SHELL_SUBDIR),
            root.join(crate::brand::STATE_SHELL_SUBDIR),
        ),
    ] {
        if !from.is_dir() {
            continue;
        }
        let _ = std::fs::create_dir_all(&to);
        if let Ok(entries) = std::fs::read_dir(&from) {
            for e in entries.flatten() {
                let dst = to.join(e.file_name());
                if dst.exists() {
                    continue;
                }
                let _ = std::fs::rename(e.path(), &dst);
            }
        }
        let _ = std::fs::remove_dir(&from);
    }
}

fn config_json() -> Option<serde_json::Value> {
    std::fs::read_to_string(supervisor_dir().join("config.json"))
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
}

pub const DEPRECATED_API_PORTS: &[u16] = &[36360];

pub fn is_deprecated_api_port(port: u16) -> bool {
    DEPRECATED_API_PORTS.contains(&port)
}

pub fn api_base_url() -> String {
    let default_port = DEFAULT_API_PORT;
    let from_config = || {
        config_json()
            .and_then(|v| v.get("apiPort").and_then(|x| x.as_u64()))
            .filter(|n| *n > 0 && *n <= u16::MAX as u64)
            .map(|n| n as u16)
    };
    let port = discovered_api_port().or_else(from_config).unwrap_or(default_port);
    
    
    
    
    let port = if is_deprecated_api_port(port) { default_port } else { port };
    format!("http://127.0.0.1:{}/", port)
}

pub fn config_flag(key: &str) -> bool {
    config_json()
        .and_then(|v| v.get(key).and_then(|x| x.as_bool()))
        .unwrap_or(false)
}

pub fn close_action() -> String {
    config_json()
        .and_then(|v| v.get("closeAction").and_then(|x| x.as_str()).map(|s| s.to_string()))
        .filter(|v| v == "exit" || v == "hide")
        .unwrap_or_else(|| "hide".into())
}

pub const DEFAULT_API_PORT: u16 = 37360;

pub fn api_port() -> u16 {
    let u = api_base_url();
    u.trim_end_matches('/')
        .rsplit(':')
        .next()
        .and_then(|p| p.parse().ok())
        .unwrap_or(DEFAULT_API_PORT)
}

pub fn discovered_api_port() -> Option<u16> {
    let s = std::fs::read_to_string(supervisor_dir().join("ports.json")).ok()?;
    let v: serde_json::Value = serde_json::from_str(&s).ok()?;
    let port = valid_api_port(
        v.get("records")?
            .as_array()?
            .iter()
            .filter(|r| r.get("role").and_then(|x| x.as_str()) == Some("supervisor-api"))
            .max_by_key(|r| r.get("createdAt").and_then(|x| x.as_u64()).unwrap_or(0)),
    )?;
        
        
        
    if is_deprecated_api_port(port) {
        return None;
    }
    Some(port)
}

fn valid_api_port(rec: Option<&serde_json::Value>) -> Option<u16> {
    let port = rec?.get("port").and_then(|x| x.as_u64())?;
    if port > 0 && port <= u16::MAX as u64 { Some(port as u16) } else { None }
}

pub fn current_api_port() -> u16 {
    discovered_api_port().unwrap_or_else(api_port)
}

pub fn ensure_global_bin_on_path() -> Result<String, String> {
    let dir = global_install_root();
    if !dir.is_dir() {
        return Ok("全局目录尚不存在，跳过 PATH 登记".to_string());
    }
    let d = dir.to_string_lossy().to_string();
    
    
    #[cfg(windows)]
    { return windows_path_add(&d); }
    #[cfg(not(windows))]
    { return unix_path_add(&d); }
}

#[cfg(windows)]
fn windows_path_add(dir: &str) -> Result<String, String> {
    use std::process::Command;
    let cur = windows_user_path().unwrap_or_default();
    if cur.split(';').any(|x| x.trim().trim_end_matches('\\').eq_ignore_ascii_case(dir.trim_end_matches('\\'))) {
        return Ok("PATH 已含全局目录".to_string());
    }
    let next = if cur.is_empty() { dir.to_string() } else { format!("{};{}", cur, dir) };
    let r = crate::bounded::run(Command::new("reg").args(["add", "HKCU\\Environment", "/v", "PATH", "/t", "REG_EXPAND_SZ", "/d", &next, "/f"]), std::time::Duration::from_secs(8));
    match r {
        Ok(o) if o.success => Ok("已登记用户 PATH（并广播环境变更）".to_string()),
        Ok(o) => Err(o.failure("reg add PATH")),
        Err(e) => Err(e),
    }
}

#[cfg(windows)]
fn windows_user_path() -> Option<String> {
    use std::process::Command;
    let r = crate::bounded::run(Command::new("reg").args(["query", "HKCU\\Environment", "/v", "PATH"]), std::time::Duration::from_secs(8));
    let o = r.ok()?;
    if !o.success { return None; }
    for line in o.stdout.lines() {
        if let Some(rest) = line.split_once("REG_EXPAND_SZ").or_else(|| line.split_once("REG_SZ")) {
            return Some(rest.1.trim().to_string());
        }
    }
    None
}

#[cfg(not(windows))]
fn unix_path_add(dir: &str) -> Result<String, String> {
    let profile = home().join(".profile");
    let line = format!("export PATH=\"$PATH:{}\"", dir);
    let cur = std::fs::read_to_string(&profile).unwrap_or_default();
    if cur.lines().any(|l| l.contains(dir)) { return Ok("PATH 已含全局目录".to_string()); }
    let next = if cur.is_empty() || !cur.ends_with('\n') { format!("{}{}\n", cur, line) } else { format!("{}{}\n", cur, line) };
    std::fs::write(&profile, next).map_err(|e| format!("写入 {} 失败: {}", profile.display(), e))?;
    Ok(format!("已登记用户 PATH（{}）", profile.display()))
}

pub fn home() -> PathBuf {
    std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("/tmp"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    
    
    #[test]
    fn a4_deprecated_ports_are_migrated() {
        for p in DEPRECATED_API_PORTS {
            assert!(
                is_deprecated_api_port(*p),
                "A-4 FAIL 弃用端口 {} 未被识别（存量用户升级后会撞上老产品守卫）",
                p
            );
        }
        assert!(
            !is_deprecated_api_port(DEFAULT_API_PORT),
            "A-4 FAIL 默认端口自身落在弃用名单里 ⇒ 每次启动都会被迁走"
        );
        assert!(!is_deprecated_api_port(37361), "A-4 FAIL 正常端口被误判为弃用");
    }

    
    
    
    
    
    
    static HOME_ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn home_env_lock() -> std::sync::MutexGuard<'static, ()> {
        HOME_ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner())
    }

    #[test]
    
    
    #[test]
    fn a5_discovered_port_ignores_deprecated() {
        let _g = home_env_lock();
        let dir = std::env::temp_dir().join(format!("dsh-a5-home-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("supervisor")).unwrap();
        let saved = std::env::var_os("HOME");
        let saved_ur = std::env::var_os("USERPROFILE");
        std::env::set_var("HOME", &dir);
        std::env::set_var("USERPROFILE", &dir);
        
        let ports = serde_json::json!({
            "records": [{ "port": 36360u16, "role": "supervisor-api", "createdAt": 1u64 }]
        });
        std::fs::write(
            dir.join("supervisor").join("ports.json"),
            serde_json::to_string(&ports).unwrap(),
        )
        .unwrap();
        let got = discovered_api_port();
        
        match &saved {
            Some(v) => std::env::set_var("HOME", v),
            None => std::env::remove_var("HOME"),
        }
        match &saved_ur {
            Some(v) => std::env::set_var("USERPROFILE", v),
            None => std::env::remove_var("USERPROFILE"),
        }
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(
            got, None,
            "A-5 FAIL ports.json 登记的弃用端口被采信 ⇒ 壳会用旧端口判服役、新端口导航"
        );
    }

    fn a3_default_port_constant_value_and_url_derivation() {
        
        
        assert_eq!(DEFAULT_API_PORT, 3736 * 10, "A-3 FAIL 默认端口常量值被改动");
        
        let _g = home_env_lock();
        let saved = std::env::var_os("HOME");
        let dir = std::env::temp_dir().join(format!("dsh-a3-home-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::env::set_var("HOME", &dir);
        let url = api_base_url();
        let port = api_port();
        match &saved {
            Some(p) => std::env::set_var("HOME", p),
            None => std::env::remove_var("HOME"),
        }
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(
            url,
            format!("http://127.0.0.1:{}/", DEFAULT_API_PORT),
            "A-3 FAIL api_base_url 未按默认常量生成"
        );
        assert_eq!(port, DEFAULT_API_PORT, "A-3 FAIL api_port 与默认端口不一致");
    }
}
