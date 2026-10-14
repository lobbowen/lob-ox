//! 运行时管理器（底座）。
//!
//! 定位：**系统级**的运行时（Runtime）管理者，不是某个程序的私有依赖捆绑。
//!
//! 与旧设计的根本区别：
//!   - 旧：Node 装进 npm 全局 prefix，只把该目录拼进**自己 spawn 的子进程** PATH。
//!     结果是系统里同时存在系统 Node 与「我们的 Node」，用户在终端里敲 node 拿到的仍是旧的，
//!     「升级 Node」只升级了自己那份，对用户与其它程序零影响。
//!   - 新：安装到**专属目录**，并把它接入**用户级 PATH**，使新开的终端、IDE、
//!     其它程序都能直接使用；升级随之对全局生效。
//!
//! 可扩展性：核心引擎（探测 / 选版 / 下载 / 校验 / 安装 / 切换 / 记录 / 卸载）
//! 与「运行时是什么」无关。新增一个运行时 = 提供一份 RuntimeSpec + 一套解包适配，
//! 不改引擎 —— 避免退化成「只为一个工具写的一次性实现」。

//! 本模块只定义结构与公共类型；各运行时的具体发现与安装由 runtime/ 下的实现提供。

pub mod engine;
pub mod node;

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// 一个运行时的静态描述：它叫什么、版本从哪来、产物长什么样。
/// 这些是**数据**而非逻辑 —— 加新运行时只需填一张表。
#[derive(Debug, Clone)]
pub struct RuntimeSpec {
    /// 稳定标识，如 "node"。用作目录名、配置键与记录键。
    pub id: &'static str,
    /// 展示名，如 "Node.js"。
    pub display_name: &'static str,
    /// 安装根目录（专属，不与 npm prefix 等他方地盘混用）。
    pub install_root: PathBuf,
    /// 解析版本用的上游索引路径，**相对镜像根**（不是完整 URL：probe_all 会自己拼接）。
    pub index_path: &'static str,
}

/// 某运行时的版本信息（来自上游索引或本机探测）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimeVersion {
    pub version: String,
    /// 是否 LTS 上游线。用于「取最新稳定」的选择策略。
    pub lts: Option<String>,
}

/// 一个运行时的**安装态**：当前实际生效的版本与落地位置。
#[derive(Debug, Clone)]
pub struct InstalledRuntime {
    pub spec_id: String,
    pub version: String,
    pub bin_dir: PathBuf,
    pub executable: PathBuf,
    /// 是否已接入用户 PATH。
    pub on_path: bool,
    pub updated_at: String,
}

/// 探测结果：一个候选来源（记录 / 已知安装点 / PATH / 内置）。
#[derive(Debug, Clone)]
pub struct ProbeCandidate {
    pub source: &'static str,
    pub executable: PathBuf,
    pub version: Option<String>,
}

/// 全局注册表：有哪些运行时受管理。
///
/// 只此一处声明「系统被管理的运行时集合」——新增运行时在这里登记一次，
/// 引擎与 UI 不再各自维护一份清单（此前 core 与壳各有一份 node-lts，正是此类分叉）。
pub fn registry() -> BTreeMap<&'static str, RuntimeSpec> {
    let mut m = BTreeMap::new();
    for spec in crate::runtime::node::spec() {
        m.insert(spec.id, spec);
    }
    m
}

/// 某运行时是否已在用户 PATH 中（用于避免重复写入）。
pub fn on_user_path(dir: &Path) -> bool {
    let path = match std::env::var_os("PATH") {
        Some(p) => p,
        None => return false,
    };
    std::env::split_paths(&path).any(|p| same_dir(&p, dir))
}

/// 目录等价比较：Windows 上路径大小写与尾斜杠都可能不同，直接 == 会漏判。
pub fn same_dir(a: &Path, b: &Path) -> bool {
    let na = crate::platform::external_path(a);
    let nb = crate::platform::external_path(b);
    if cfg!(windows) {
        na.to_string_lossy().to_lowercase() == nb.to_string_lossy().to_lowercase()
    } else {
        na == nb
    }
}
/// 某个运行时的专属安装根。
///
/// 位置选择的原则：**用户级、不侵占他方地盘、不与 npm 全局包混用**。
/// 用 LOCALAPPDATA 而非 APPDATA：APPDATA 是漫游配置区（会被同步/备份策略影响），
/// 运行时是大体积可重建产物，更适合放本地应用数据区。
pub fn root_for(id: &str) -> PathBuf {
    let base = if cfg!(windows) {
        std::env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| crate::env::home().join("AppData").join("Local"))
    } else if cfg!(target_os = "macos") {
        crate::env::home().join("Library").join("Application Support")
    } else {
        std::env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| crate::env::home().join(".local").join("share"))
    };
    base.join("lobox").join("runtime").join(id)
}

/// 把某运行时的 bin 目录接入**用户级 PATH**，使其对系统全局可用。
///
/// 这是「全局可用」与「私有捆绑」的根本差别：改用户 PATH 后，新开的终端、
/// IDE 以及其它程序调用 `node` 拿到的就是我们管理的这一份。
///
/// 返回是否发生了变更。不做「去重后再加」的幂等魔法 —— 调用方按返回的
/// changed 决定要不要提示用户重启终端。
pub fn ensure_on_user_path(bin_dir: &Path) -> Result<bool, String> {
    if on_user_path(bin_dir) {
        return Ok(false);
    }
    let key = if cfg!(windows) { "PATH" } else { "PATH" };
    let cur = std::env::var(key).unwrap_or_default();
    let mut parts: Vec<String> = cur
        .split(if cfg!(windows) { ';' } else { ':' })
        .filter(|s| !s.trim().is_empty())
        .map(String::from)
        .collect();
    parts.insert(0, bin_dir.to_string_lossy().to_string());
    let next = parts.join(if cfg!(windows) { ";" } else { ":" });
    if cfg!(windows) {
        crate::platform::set_windows_user_env(key, &next)?;
    } else {
        crate::platform::append_unix_path_export(bin_dir)?;
    }
    Ok(true)
}

