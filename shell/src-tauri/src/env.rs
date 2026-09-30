//! 环境探测：Node 定位 / 版本 / 产品状态根。
//! 本文件的子进程一律先经 `bounded::prepare`（CREATE_NO_WINDOW 的唯一封装点）——
//!   release 下壳是 GUI 子系统，不带该标志时每次探测都会弹一个控制台窗口。
//! 复用 prepare 而非 `bounded::run`：须保留 spawn 后轮询 try_wait 的非阻塞行为（Store 别名存根会挂起）。

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

/// Node 版本探测的时间上限。
///
/// Windows 的 `WindowsApps\node.exe` 是 Store 应用执行别名存根，执行会挂起 —— 必须有界。
const NODE_PROBE_TIMEOUT: Duration = Duration::from_secs(5);

/// 兼容包装 probe_system_node 的有界预算（真正执行在 nodeprobe 的分离线程里）。
const NODE_PROBE_TOTAL_BUDGET: Duration = Duration::from_secs(20);

/// Node 可执行名 —— 平台知识已下沉到 trait（P2/G1：原为 `cfg!()` 宏，门禁 G1 只拦 `#[cfg(` 属性，看不见它）。
pub fn node_exe() -> &'static str {
    crate::platform::current().node_exe_name()
}

/// 候选是否可用（平台判定，实现在 platform 层）。
/// Windows 必须过滤两类伪可执行：`\WindowsApps\` 下的 Store 执行别名存根（执行会挂起）、
/// 0 字节文件。
pub fn is_usable_candidate(cand: &Path) -> bool {
    crate::platform::current().is_usable_executable(cand)
}

/// PATH 扫描的总预算：即使 PATH 里存在会阻塞的路径，也不会把调用方拖成分钟级。
/// 说明：这是「快速失败」，不是唯一防线 —— nodeprobe 的分离线程机制才是硬保证。
const PATH_SCAN_BUDGET: Duration = Duration::from_secs(10);

/// PATH 扫描（**有界 + 安全过滤**）。
///
/// 预算 PATH_SCAN_BUDGET；Windows 跳过非固定盘与 UNC（本地判定，不触网）。
pub fn find_in_path(name: &str) -> Option<PathBuf> {
    let started = Instant::now();
    for dir in path_dirs_local_only() {
        if started.elapsed() >= PATH_SCAN_BUDGET { break; }
        let cand = dir.join(name);
        if is_usable_candidate(&cand) { return Some(cand); }
    }
    None
}

/// PATH 中的目录，已过滤掉「可能阻塞」的项（非固定盘 / UNC）。
/// 供 nodeprobe 与 find_in_path 共用，保证探测与定位走同一套安全判定。
pub fn path_dirs_local_only() -> Vec<PathBuf> {
    let mut out = Vec::new();
    let Some(path) = std::env::var_os("PATH") else { return out };
    for dir in std::env::split_paths(&path) {
        if !is_local_fixed_dir(&dir) { continue; }
        out.push(dir);
    }
    out
}

/// 该目录是否位于本地固定盘（平台判定；在触网操作之前完成，按盘符缓存 GetDriveTypeW）。
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

/// 有界执行 `<node> --version`。
/// 超时/失败一律返回 None（视为「不可用」），**绝不阻塞调用方** ——
/// 这是「引导页不会因某个坏的可执行文件而永久卡住」的根本保证。
pub fn node_version(node: &Path) -> Option<String> {
    use std::process::Stdio;
    // 先建命令再显式 prepare：不加该标志时，GUI 子系统下的每次探测都会弹控制台窗口。
    let mut cmd = Command::new(node);
    cmd.arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    // 与 bounded::run 同源：CREATE_NO_WINDOW 只在此封装点加（平台分支不得外溢到本文件）。
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

/// 系统 PATH 中的 Node：缺失返回 None。
/// 必须**遍历全部候选**而非取第一个：PATH 靠前的可能是不可用存根，会掩盖后面真正可用的安装。
/// 兼容入口：委托 nodeprobe 有界探测（分离线程 + 有界等待 + 结果缓存）；
/// 保留本函数使所有既有调用点自动获得该保证，无需逐个改写。
pub fn probe_system_node() -> Option<(PathBuf, String)> {
    crate::nodeprobe::resolve(NODE_PROBE_TOTAL_BUDGET)
}

/// 用户级 Node 安装根（**零权限**）：<状态根>/node。
/// 系统级安装（Windows MSI / macOS pkg / Linux /usr/local）需提权，且 Windows 上 UAC 提升到
/// 管理员账户后常读不到当前用户 profile 下的安装包；用户级归档三平台一致、完全不需要授权。
pub fn node_install_root() -> PathBuf {
    state_root().join("node")
}

/// **安装后** Node 可执行文件应出现的位置（平台判定，实现在 platform 层）。
/// Windows 不得硬编码 `C:\Program Files`：真实路径随系统盘符与系统语言变化
/// （中文系统是本地化目录名），也可能装在 `Program Files (x86)`；
/// 一律经 `ProgramFiles` / `ProgramFiles(x86)` 环境变量推导（nodeprobe 同口径，两处必须一致）。
pub fn known_install_node_path() -> Option<PathBuf> {
    let p = crate::platform::current().node_bin_after_install();
    if p.is_file() {
        Some(p)
    } else {
        None
    }
}

/// 产品状态根 schema（与内核 src/platform/state-root.js 的 SCHEMA 握手；门禁锁定）。
pub const STATE_ROOT_SCHEMA: u32 = 1;

/// 产品状态根（**独立于 DSH 的 ~/.dsh**）：`DSH_SUPERVISOR_HOME` 覆盖，否则平台默认。
///
/// 为什么独立：本产品**管控** DSH，把状态放在被管控对象的 ~/.dsh 下是概念错位 ——
///   DSH 卸载/清理/迁移数据目录会把我们的 config/state/ports/logs 一并带走。
pub fn state_root() -> PathBuf {
    if let Ok(v) = std::env::var("DSH_SUPERVISOR_HOME") {
        if !v.trim().is_empty() {
            return PathBuf::from(v.trim());
        }
    }
    crate::platform::current().state_root_default()
}

/// 内核状态目录（config/state/ports/logs/契约）：<状态根>/supervisor。
pub fn supervisor_dir() -> PathBuf {
    state_root().join("supervisor")
}

/// 桌面壳状态目录（identity/mirrors/shell.log）：<状态根>/shell。
pub fn shell_dir() -> PathBuf {
    state_root().join("shell")
}

/// 前向自愈迁移：把旧位置（DSH 数据目录下）的条目并入产品状态根，不覆盖已存在文件。
/// 在壳启动早期调用一次；失败不阻断（下次启动再试）。退役依据：状态根独立自 v1.1.2 随壳发布，而本函数
/// 每次 setup 都跑 —— 装机升级过一次即已迁移完成、此后是 no-op。可删条件 = 活跃装机最低版本 >= 1.1.2；
/// 收口时同步改 K-8（它把 `pub fn migrate_legacy` 钉为状态根契约成员）与 main.rs 的调用点。
pub fn migrate_legacy() {
    let home = home();
    let root = state_root();
    for (from, to) in [
        (home.join(".dsh").join("supervisor"), root.join("supervisor")),
        (home.join(".dsh").join("shell"), root.join("shell")),
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

/// 读取并解析守卫配置 <产品状态根>/supervisor/config.json（**壳读内核配置的唯一解析入口**）。
/// 契约 ARCHITECTURE-CONTRACT-phase0：一律真 JSON 解析，禁止字符串扫描——
/// 空白的格式微调即会让扫描失效（apiPort/closeAction 等字段都从这里取）。
fn config_json() -> Option<serde_json::Value> {
    std::fs::read_to_string(supervisor_dir().join("config.json"))
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
}

/// 守卫本地 API 基址：**与就绪判据同一个端口源**。优先 ports.json 的实际登记（契约 D3 的
/// 权威），其次 config.json 的 apiPort（用户可改），最后才落回默认常量。只认期望值会把面板
/// 导航到一个没人监听的端口 —— 守卫因占用顺延过端口时必然失配，而就绪侧早已改读实际值，
/// 导航侧不许留着第二套答案。
pub fn api_base_url() -> String {
    // 默认端口只允许 DEFAULT_API_PORT 这一个事实源（本函数与 api_port 的回退共用它）。
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

/// 读守卫 config.json 里的一个**布尔开关**（缺失/非布尔/解析失败 = false）。
/// 判定**只认真 JSON 布尔 true**（字符串 `"true"` 不算）：防手改配置少读一位，
/// 把稳定版机器悄悄变成灰度机。字段读取一律经本函数，不出现第二份解析实现。
pub fn config_flag(key: &str) -> bool {
    config_json()
        .and_then(|v| v.get(key).and_then(|x| x.as_bool()))
        .unwrap_or(false)
}

/// 关闭窗口时的行为（读守卫 config.closeAction；'exit'=退出管家全关，其余=隐藏至托盘）。
pub fn close_action() -> String {
// 解析统一走 config_json（真 JSON，契约禁止字符串扫描）。语义：exit=退出管家；其余（含缺失/解析失败）= 隐藏至托盘。
    // serde_json 已是壳依赖（见 Cargo.toml），零新增依赖。
    config_json()
        .and_then(|v| v.get("closeAction").and_then(|x| x.as_str()).map(|s| s.to_string()))
        .filter(|v| v == "exit" || v == "hide")
        .unwrap_or_else(|| "hide".into())
}

/// 守卫 API 的**默认端口**（单一事实源；api_base_url 与 api_port 的回退共用本常量）。
/// 门禁 A-3（本文件 tests）锁定「全文件只允许一个默认端口字面量」。
pub const DEFAULT_API_PORT: u16 = 36360;

/// 壳可用性探测用守卫端口（与 api_base_url 同源解析）。
pub fn api_port() -> u16 {
    let u = api_base_url();
    // 从派生出的 URL 反解端口；回退到**同一个**默认端口常量（而非另一个字面量）。
    u.trim_end_matches('/')
        .rsplit(':')
        .next()
        .and_then(|p| p.parse().ok())
        .unwrap_or(DEFAULT_API_PORT)
}

/// 内核持久化的**实际** API 端口（ports.json 的 supervisor-api 记录）。
/// 必须读实际值：内核在 EADDRINUSE 时会顺延端口并持久化，只认 config.json 的期望值会让壳
///   永远等一个没人监听的端口，表现为「守卫启动失败」——即使守卫已健康运行。
/// 同 role 有多条时取 `createdAt` 最新的一条：登记表以端口号为键，旧记录只在 release 真生效时才消失。
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

/// 记录里的端口是否为合法 API 端口（缺失/越界 = None，与配置读取同一值域判据）。
fn valid_api_port(rec: Option<&serde_json::Value>) -> Option<u16> {
    let port = rec?.get("port").and_then(|x| x.as_u64())?;
    if port > 0 && port <= u16::MAX as u64 { Some(port as u16) } else { None }
}

/// 当前应使用的内核 API 端口：**实际绑定值优先**，退回配置期望值（单一入口）。
pub fn current_api_port() -> u16 {
    discovered_api_port().unwrap_or_else(api_port)
}

pub fn home() -> PathBuf {
    std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("/tmp"))
}


#[cfg(test)]
mod tests {
    use super::*;

    /// A-3（行为）：默认端口常量确实等于契约里的高位段起始，且 url 由它派生。
    #[test]
    fn a3_default_port_constant_value_and_url_derivation() {
        assert_eq!(DEFAULT_API_PORT, 3636 * 10, "A-3 FAIL 默认端口常量值被改动");
        // 在一个**空 HOME** 下：无 config.json，必须落回 DEFAULT_API_PORT。
        // 用锁串行，避免与其它读 HOME 的用例并发互踩。
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
