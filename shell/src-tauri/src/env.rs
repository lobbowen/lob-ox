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
    if let Ok(v) = std::env::var(crate::brand::env_state_root()) {
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
            home.join(crate::brand::legacy_harness_dir()).join(crate::brand::STATE_SUPERVISOR_SUBDIR),
            root.join(crate::brand::STATE_SUPERVISOR_SUBDIR),
        ),
        (
            home.join(crate::brand::legacy_harness_dir()).join(crate::brand::STATE_SHELL_SUBDIR),
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

static DEPRECATED_API_PORTS_CELL: std::sync::OnceLock<Vec<u16>> = std::sync::OnceLock::new();

pub fn deprecated_api_ports() -> &'static [u16] {
    DEPRECATED_API_PORTS_CELL.get_or_init(|| {
        let mut v: Vec<u16> = Vec::new();
        for i in 0..8 {
            let key = format!("net.deprecatedApiPorts.{}", i);
            match std::panic::catch_unwind(|| crate::brand::shared_num(&key)) {
                Ok(n) if n > 0 => v.push(n),
                _ => break,
            }
        }
        v
    })
}

pub fn is_deprecated_api_port(port: u16) -> bool {
    deprecated_api_ports().contains(&port)
}

pub fn api_base_url() -> String {
    let default_port = default_api_port();
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

static DEFAULT_API_PORT_CELL: std::sync::OnceLock<u16> = std::sync::OnceLock::new();

// 端口真相来自 shared-constants.json（经 brand::shared_num 读取）。
// 不能用 const：解析器依赖运行期字符串操作。OnceLock 保证只解析一次。
pub fn default_api_port() -> u16 {
    *DEFAULT_API_PORT_CELL.get_or_init(|| crate::brand::shared_num("net.apiPort"))
}

pub fn api_port() -> u16 {
    let u = api_base_url();
    u.trim_end_matches('/')
        .rsplit(':')
        .next()
        .and_then(|p| p.parse().ok())
        .unwrap_or(default_api_port())
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

/// 壳访问内核 API 的**唯一**端口解析。
/// 此前托盘闭包读 env.tray_port 再回落 current_api_port，而 CloseRequested 直接用
/// current_api_port：同一进程两条路径给出两个端口（tray_port 覆盖时生命周期动作
/// 打向另一个端口，退出却打向真端口）。环境变量名保留（它在 shared-constants 里，
/// 属跨语言契约），但两处必须调同一个函数。
pub fn resolved_api_port() -> u16 {
    std::env::var(crate::brand::env_tray_port())
        .ok()
        .and_then(|p| p.trim().parse::<u16>().ok())
        .filter(|p| *p > 0)
        .unwrap_or_else(current_api_port)
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
    // 防呆：新 PATH 不得比读到的旧 PATH 更短（更短意味着续行没拼全，写回即丢数据）。
    if !cur.is_empty() && next.len() < cur.len() {
        return Err(format!("拒绝写入：新 PATH({}) 短于现值({})，疑似续行未拼全", next.len(), cur.len()));
    }
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
    // reg query 对长值按物理行折行，续行不带类型标记。只取含标记那一行会静默
    // 截断用户 PATH 尾部；必须把其后所有续行一并拼回。
    let mut lines = o.stdout.lines();
    let mut acc: Option<String> = None;
    while let Some(line) = lines.next() {
        let marked = line
            .split_once("REG_EXPAND_SZ")
            .or_else(|| line.split_once("REG_SZ"));
        if let Some((_, rest)) = marked {
            let mut val = rest.trim().to_string();
            for cont in lines.by_ref() {
                if cont.contains("REG_EXPAND_SZ") || cont.contains("REG_SZ") {
                    break;
                }
                let t = cont.trim();
                if t.is_empty() {
                    continue;
                }
                // reg 按固定列宽折行，断点可能落在 token 中间，不能一律补 ';'。
                // 仅当续行自身像一个新条目（盘符或 UNC 开头）时才补分隔。
                let looks_new_entry = t.starts_with("\\\\")
                    || (t.len() >= 2 && t.as_bytes()[1] == b':' && (t.as_bytes()[0] as char).is_ascii_alphabetic());
                if looks_new_entry && !val.ends_with(';') {
                    val.push(';');
                }
                val.push_str(t);
            }
            acc = Some(val);
            break;
        }
    }
    acc
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
    fn a4_deprecated_ports_are_migrated() {
        for p in deprecated_api_ports() {
            assert!(
                is_deprecated_api_port(*p),
                "A-4 FAIL 弃用端口 {} 未被识别（存量用户升级后会撞上老产品内核）",
                p
            );
        }
        assert!(
            !is_deprecated_api_port(default_api_port()),
            "A-4 FAIL 默认端口自身落在弃用名单里 ⇒ 每次启动都会被迁走"
        );
        assert!(!is_deprecated_api_port(37361), "A-4 FAIL 正常端口被误判为弃用");
    }

    
    
    
    
    
    
    static HOME_ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn home_env_lock() -> std::sync::MutexGuard<'static, ()> {
        HOME_ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// 弃用端口不得被采信。
    ///
    /// 守护的判据：`ports.json` 里登记的端口若在弃用名单上，`discovered_api_port()`
    /// 必须返回 None —— 否则壳会用旧端口判服役、新端口导航，两侧对不上。
    ///
    /// 构造走 `DSH_SUPERVISOR_HOME`（`state_root()` 的第一优先，见本文件 `:128`），
    /// **不碰 HOME/USERPROFILE**：那三个是全局环境，`cargo test` 多线程并行时
    /// 与别的文件测试互相干扰（各文件的锁互不相识），而这个断言只需要「换一个
    /// 状态根」，用最小侵入的那个键。
    #[test]
    fn a5_discovered_port_ignores_deprecated() {
        let dir = std::env::temp_dir().join(format!("dsh-a5-root-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("supervisor")).unwrap();
        let ports = serde_json::json!({
            "records": [{ "port": 36360u16, "role": "supervisor-api", "createdAt": 1u64 }]
        });
        std::fs::write(
            dir.join("supervisor").join("ports.json"),
            serde_json::to_string(&ports).unwrap(),
        )
        .unwrap();
        let key = crate::brand::env_state_root();
        let saved = std::env::var_os(key);
        std::env::set_var(key, &dir);
        let got = discovered_api_port();
        match &saved {
            Some(v) => std::env::set_var(key, v),
            None => std::env::remove_var(key),
        }
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(
            got, None,
            "A-5 FAIL ports.json 登记的弃用端口被采信 ⇒ 壳会用旧端口判服役、新端口导航"
        );
    }

    /// 默认端口常量与 URL 推导的**跨语言单源**不变量。
    ///
    /// 为什么值得一条测试：`default_api_port()` 的值必须等于 `net.apiPort`
    /// （`shared-constants.json`），而 `api_base_url()` 必须按同一个常量生成。
    /// 这三条断言守护的是「改一处而另一处不知情」这个跨侧漂移 —— 它无法靠
    /// 类型系统防（常量是运行期从 JSON 读的），只能靠断言。
    ///
    /// 构造刻意不碰全局 HOME/USERPROFILE：本断言与 HOME 无关（前一条已覆盖
    /// 「HOME 影响端口发现」），且 `cargo test` 多线程并行时改全局环境会与
    /// 其他文件的测试互相干扰（各文件的锁互不相识）。
    #[test]
    fn a3_default_port_constant_value_and_url_derivation() {
        assert_eq!(default_api_port(), 3736 * 10, "A-3 FAIL 默认端口常量值被改动");
        let url = api_base_url();
        let port = api_port();
        assert_eq!(
            url,
            format!("http://127.0.0.1:{}/", default_api_port()),
            "A-3 FAIL api_base_url 未按默认常量生成"
        );
        assert_eq!(port, default_api_port(), "A-3 FAIL api_port 与默认端口不一致");
    }
}
