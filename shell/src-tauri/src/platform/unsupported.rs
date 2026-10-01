//! 未支持平台的显式实现：让「不支持」成为编译期存在、运行期可见的事实，绝不静默成功。与内核 `platform/os/service.js` 的 `CapabilityError` 同规。

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
        None
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



    fn is_defined(&self) -> bool {
        false
    }
}

impl Platform for Impl {
    fn node_artifact(&self, _version: &str) -> Option<super::NodeArtifact> {
                // 未知平台：显式返回 None（无可用制品）。只给通用 Unix 落点（未知平台多半是类 Unix）；探测失败由调用方如实报告。
        None
    }

    fn node_candidate_paths(&self) -> Vec<PathBuf> {
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

    fn core_bin_candidates_in_prefix(
        &self,
        prefix: &Path,
        names: &[&str],
        _pkg: Option<&str>,
    ) -> Vec<PathBuf> {
        names.iter().map(|n| prefix.join("bin").join(n)).collect()
    }

    fn state_root_default(&self) -> PathBuf {
        if let Some(x) = std::env::var_os("XDG_STATE_HOME") {
            if !x.is_empty() {
                return Path::new(&x).join("dsh-supervisor");
            }
        }
        super::home_dir().join(".local").join("state").join("dsh-supervisor")
    }

    fn is_local_fixed_dir(&self, _dir: &Path) -> bool {
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

    fn node_exe_name(&self) -> &'static str { "node" }
    fn npm_exe_name(&self) -> &'static str { "npm" }
    fn core_exe_names(&self) -> &'static [&'static str] { &["dsh-supervisor"] }
    fn is_directly_spawnable(&self, _prog: &Path) -> bool { true }
}