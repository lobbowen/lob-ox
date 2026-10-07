//! 未支持平台的显式实现：让「不支持」成为编译期存在、运行期可见的事实，绝不静默成功。
//! 与内核 `platform/os/service.js` 的 `CapabilityError` 同规。
//!
//! ⚠ 只在 `not(any(linux, macos, windows))` 下编译 ⇒ 四平台 CI **永不覆盖本文件**。
//!   故本文件的任何错误都不会在 CI 上暴露，改动后必须人工确认。
//!
//! 约束：`impl Platform for Impl` 在本文件内**只能有一段**（重复实现 ⇒ E0119）。

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

    fn node_artifact(&self, _version: &str) -> Option<super::NodeArtifact> {
        // 未知平台：显式返回 None（无可用制品）。探测失败由调用方如实报告，不猜一个。
        None
    }

    fn node_candidate_paths(&self) -> Vec<PathBuf> {
        vec![PathBuf::from("/usr/local/bin/node"), PathBuf::from("/usr/bin/node")]
    }

    fn node_bin_after_install(&self) -> PathBuf {
        PathBuf::from("/usr/local/bin")
    }

    fn is_usable_executable(&self, cand: &Path) -> bool {
        cand.is_file()
    }

    fn core_extra_candidates(&self, _names: &[&str], _pkg: Option<&str>) -> Vec<std::path::PathBuf> {
        Vec::new()
    }

    fn core_bin_candidates_in_prefix(
        &self,
        prefix: &Path,
        names: &[&str],
        _pkg: Option<&str>,
    ) -> Vec<std::path::PathBuf> {
        names.iter().map(|n| prefix.join("bin").join(n)).collect()
    }

    fn state_root_default(&self) -> PathBuf {
        crate::brand::state_root_linux(
            std::env::var_os(crate::brand::STATE_ROOT_LINUX_XDG_ENV),
            &super::home_dir(),
        )
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
    fn core_exe_names(&self) -> &'static [&'static str] { &["lobox"] }
    fn is_directly_spawnable(&self, _prog: &Path) -> bool { true }
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
}
