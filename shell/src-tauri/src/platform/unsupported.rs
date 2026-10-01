//! 未支持平台的显式实现：让「不支持」成为编译期存在、运行期可见的事实，绝不静默成功。
//! 与内核 `platform/os/service.js` 的 `CapabilityError` 同规。

use std::path::{Path, PathBuf};

use super::service::ServiceControl;
use super::{Capabilities, LaunchSpec, Platform};

pub const NAME: &str = "unsupported";

pub struct Impl;
static IMPL: Impl = Impl;

pub fn platform() -> &'static dyn Platform {
    &IMPL
}

pub fn service() -> &'static dyn ServiceControl {
    &IMPL
}

impl Platform for Impl {
    fn name(&self) -> &'static str {
        NAME
    }
    fn service(&self) -> &'static dyn ServiceControl {
        &IMPL
    }
    fn capabilities(&self) -> Capabilities {
        Capabilities {
            platform: NAME,
            native_service: false,
            privilege_channel: false,
            node_artifact: "unknown",
        }
    }

    fn core_platform_tag(&self) -> Option<&'static str> {
        None // 未知平台无对应内核发布包（如实返回，不猜）
    }
}

impl ServiceControl for Impl {
    fn kind(&self) -> &'static str {
        "none"
    }

    fn definition_path(&self) -> PathBuf {
        PathBuf::from("unsupported")
    }

    fn ensure_defined(&self, _spec: &LaunchSpec) -> Result<String, String> {
        Err(format!("当前平台（{}）不支持服务定义", std::env::consts::OS))
    }

    fn start(&self) -> Result<(), String> {
        Err(format!("当前平台（{}）不支持守卫服务管理", std::env::consts::OS))
    }

    fn stop(&self) -> Result<(), String> {
        Err(format!("当前平台（{}）不支持守卫服务管理", std::env::consts::OS))
    }



    /// 未知平台：没有服务定义，显式返回 false（默认实现是 `definition_path().is_file()`）。
    fn is_defined(&self) -> bool {
        false
    }
}

// 注意：`Impl` 的 Platform 与 ServiceControl 两个 impl 块各自收束，方法不得错位。
impl Platform for Impl {
    fn node_artifact(&self, _version: &str) -> Option<super::NodeArtifact> {
        // 未知平台：显式返回 None（无可用制品）。
        None
    }

    fn node_candidate_paths(&self) -> Vec<PathBuf> {
        // 只给通用 Unix 落点（未知平台多半是类 Unix）；探测失败由调用方如实报告。
        vec![
            PathBuf::from("/usr/local/bin/node"),
            PathBuf::from("/usr/bin/node"),
        ]
    }

    fn node_bin_after_install(&self) -> PathBuf {
        PathBuf::from("/usr/local/bin/node")
    }

    fn is_usable_executable(&self, cand: &Path) -> bool {
        cand.is_file()
    }

    fn core_extra_candidates(&self, _names: &[&str], _pkg: Option<&str>) -> Vec<PathBuf> {
        Vec::new()
    }

    /// 未知平台按 POSIX 形态给出（保守）：<prefix>/bin/<name>。
    fn core_bin_candidates_in_prefix(
        &self,
        prefix: &Path,
        names: &[&str],
        _pkg: Option<&str>,
    ) -> Vec<PathBuf> {
        names.iter().map(|n| prefix.join("bin").join(n)).collect()
    }

    /// 未知平台按 XDG 兜底。
    fn state_root_default(&self) -> PathBuf {
        if let Some(x) = std::env::var_os("XDG_STATE_HOME") {
            if !x.is_empty() {
                return Path::new(&x).join("dsh-supervisor");
            }
        }
        super::home_dir().join(".local").join("state").join("dsh-supervisor")
    }

    fn is_local_fixed_dir(&self, _dir: &Path) -> bool {
        // 无「网络盘 / 可移动盘」的 is_file() 触网风险，本地文件系统调用不会因路径本身阻塞数十秒。
        true
    }

    fn install_node(&self, _file: &Path) -> Result<PathBuf, String> {
        Err(format!(
            "当前平台（{}）不支持自动安装 Node —— 请手动安装后重启桌面壳",
            std::env::consts::OS
        ))
    }

    fn has_privilege_channel(&self) -> bool {
        false
    }

    // 未知平台按 POSIX 形态给出（保守：至少不引入 Windows 专有扩展名）。
    fn node_exe_name(&self) -> &'static str { "node" }
    fn npm_exe_name(&self) -> &'static str { "npm" }
    fn core_exe_names(&self) -> &'static [&'static str] { &["dsh-supervisor"] }
    // 未知平台按 POSIX 形态给出（与上面三个文件名同一保守口径）。
    fn is_directly_spawnable(&self, _prog: &Path) -> bool { true }
}