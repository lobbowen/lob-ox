//! 本文件的子进程一律先经 `bounded::prepare`（CREATE_NO_WINDOW 的唯一封装点）；release 下壳是 GUI 子系统，不带该标志时每次探测都会弹控制台窗口。复用 prepare 而非 `bounded::run`，以保留 spawn 后轮询 try_wait 的非阻塞行为。

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

/// Node 版本探测的时间上限：Windows 的 `WindowsApps\node.exe` 是 Store 应用执行别名存根，执行会挂起 —— 必须有界。
const NODE_PROBE_TIMEOUT: Duration = Duration::from_secs(5);

const NODE_PROBE_TOTAL_BUDGET: Duration = Duration::from_secs(20);

pub fn node_exe() -> &'static str {
    crate::platform::current().node_exe_name()
}

/// Windows 必须过滤两类伪可执行：`\WindowsApps\` 下的 Store 执行别名存根（执行会挂起）、0 字节文件。
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

/// 超时/失败一律返回 None（视为不可用），绝不阻塞调用方 —— 这是「引导页不会因某个坏的可执行文件而永久卡住」的根本保证。
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

/// 全局工具链安装根（**用户级、零权限、跨产品共享**）。
///
/// 决策：产品不再把 Node/DSH 私有化到状态根 —— 私有化导致「装完了谁也看不见」：
/// 运行时只能靠自造 PATH 找到自己装的东西，于是两个产品各装一份、彼此不通，
/// DSH 装在其中一家，另一家就永远报「未安装」。
/// 现改为用户级全局落点（与 pip --user / npm 用户 prefix 同源）：
///   - Windows：%APPDATA%\\lobox\bin（npm 的 %APPDATA%\npm 语义相近，但独立子目录便于卸载）
///   - 其它：<home>/.local/bin
/// 前提：机器级目录（Program Files / /usr/local）在无管理员时不可写（实测 EPERM），故只取用户级。
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

/// 用户级 Node 安装根（**零权限**）：<状态根>/node。
/// 兼容：老布局的状态根下若已装过 Node，继续复用（避免把既有用户硬搬到新目录）。
pub fn node_install_root() -> PathBuf {
    state_root().join("node")
}

/// 全局 Node 落点（新布局）：优先取全局根，回落到状态根（老布局已装时不动）。
pub fn node_install_target() -> PathBuf {
    let old_root = node_install_root();
    if old_root.join(node_exe_name_platform()).is_file() {
        return old_root;
    }
    global_install_root()
}

fn node_exe_name_platform() -> &'static str {
    crate::platform::current().node_exe_name()
}

pub fn known_install_node_path() -> Option<PathBuf> {
    let p = crate::platform::current().node_bin_after_install();
    if p.is_file() {
        Some(p)
    } else {
        None
    }
}

/// 产品状态根 schema（与内核 src/platform/state-root.js 的 SCHEMA 握手）。
pub const STATE_ROOT_SCHEMA: u32 = 1;

/// 必须独立于 DSH 的 ~/.dsh：本产品**管控** DSH，放在被管控对象的 ~/.dsh 下会被 DSH 的卸载/清理/迁移一并带走（config/state/ports/logs）。
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

/// 前向自愈迁移：把旧位置（DSH 数据目录下）的条目并入产品状态根，不覆盖已存在文件；壳启动早期调用一次，失败不阻断，迁移完成后为 no-op。
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

/// 一律真 JSON 解析，禁止字符串扫描 —— 空白格式微调即会让扫描失效（apiPort/closeAction 等字段都从这里取）。
fn config_json() -> Option<serde_json::Value> {
    std::fs::read_to_string(supervisor_dir().join("config.json"))
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
}

/// 守卫本地 API 基址：**与就绪判据同一个端口源**（优先 ports.json 的实际登记，其次 config.json 的 apiPort，最后落回默认常量）—— 守卫因占用顺延过端口时必然失配，导航侧不许留着第二套答案。
pub fn api_base_url() -> String {
    let default_port = DEFAULT_API_PORT;
    let from_config = || {
        config_json()
            .and_then(|v| v.get("apiPort").and_then(|x| x.as_u64()))
            .filter(|n| *n > 0 && *n <= u16::MAX as u64)
            .map(|n| n as u16)
    };
    let port = discovered_api_port().or_else(from_config).unwrap_or(default_port);
    format!("http://127.0.0.1:{}/", port)
}

/// 判定只认真 JSON 布尔 true（字符串 `"true"` 不算）：防手改配置少读一位，把稳定版机器悄悄变成灰度机；字段读取一律经本函数。
pub fn config_flag(key: &str) -> bool {
    config_json()
        .and_then(|v| v.get(key).and_then(|x| x.as_bool()))
        .unwrap_or(false)
}

/// 关闭窗口时的行为（读守卫 config.closeAction；'exit'=退出管家全关，其余含缺失/解析失败=隐藏至托盘）。
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

/// 内核持久化的**实际** API 端口：内核在 EADDRINUSE 时会顺延端口并持久化，只认 config.json 的期望值会让壳永远等一个没人监听的端口；同 role 有多条时取 `createdAt` 最新的一条（登记表以端口号为键）。
pub fn discovered_api_port() -> Option<u16> {
    let s = std::fs::read_to_string(supervisor_dir().join("ports.json")).ok()?;
    let v: serde_json::Value = serde_json::from_str(&s).ok()?;
    valid_api_port(
        v.get("records")?
            .as_array()?
            .iter()
            .filter(|r| r.get("role").and_then(|x| x.as_str()) == Some("supervisor-api"))
            .max_by_key(|r| r.get("createdAt").and_then(|x| x.as_u64()).unwrap_or(0)),
    )
}

fn valid_api_port(rec: Option<&serde_json::Value>) -> Option<u16> {
    let port = rec?.get("port").and_then(|x| x.as_u64())?;
    if port > 0 && port <= u16::MAX as u64 { Some(port as u16) } else { None }
}

pub fn current_api_port() -> u16 {
    discovered_api_port().unwrap_or_else(api_port)
}

/// 把全局 bin 目录**登记进用户级 PATH**（Q1 决策：装完必须能被看见）。
///
/// 存在理由：此前全仓 0 处写 PATH —— 装到哪都行，但终端/其它产品**永远找不到**，
/// 于是只能靠运行时自造 PATH 找到自己装的东西（这正是"私有化"的实质）。
/// 语义：只写**用户级**环境变量（HKCU\\Environment / shell profile），不动机器级，零权限。
pub fn ensure_global_bin_on_path() -> Result<String, String> {
    let dir = global_install_root();
    if !dir.is_dir() {
        return Ok("全局目录尚不存在，跳过 PATH 登记".to_string());
    }
    let d = dir.to_string_lossy().to_string();
    // 平台分支必须走**编译期** #[cfg]：若用运行时 cfg!()，非目标平台的分支函数不会被编译，
    // 在 Linux/macOS 上直接 E0425（找不到函数）—— CI 四平台编译会全红。
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
    fn a3_default_port_constant_value_and_url_derivation() {
        // 端口常量冻结：改端口须同步改此处，并同步 core/src/platform/service/config.js#apiPort（两处单源）。
        // 37360 而非 36360：老产品 dsh-supervisor 的守卫常驻 36360，新产品原会命中「守卫在服役·跳过启动」。
        assert_eq!(DEFAULT_API_PORT, 3736 * 10, "A-3 FAIL 默认端口常量值被改动");
        static SERIAL: std::sync::Mutex<()> = std::sync::Mutex::new(());
        let _g = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
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
