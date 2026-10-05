//! macOS 平台实现（平台知识集中于此）。
//! 服务管理由产品自身的监控器承担（见 `super::service`）：本文件**不调用** launchd / launchctl
//! —— 操作系统服务机制与本产品无关，也不存在「用系统通道投递」的选项。

use std::path::{Path, PathBuf};
use std::process::Command;

use super::service::ServiceControl;
use super::{home_dir, Capabilities, LaunchSpec, Platform};

pub const NAME: &str = "macos";

const INSTALL_CMD_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15 * 60);

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
            native_service: true,
            privilege_channel: true,
            node_artifact: "tar.gz",
        }
    }

    fn core_platform_tag(&self) -> Option<&'static str> {
        match std::env::consts::ARCH {
            "x86_64" => Some("darwin-x64"),
            "aarch64" => Some("darwin-arm64"),
            _ => None,
        }
    }

    fn node_artifact(&self, version: &str) -> Option<super::NodeArtifact> {
                // 用户级安装：官方 tarball 双架构齐全（osx-x64-tar / osx-arm64-tar），零权限。官方没有 osx-arm64-pkg 且 .pkg 需系统授权，故用 tar 归档而非 pkg。
        let arch = match std::env::consts::ARCH {
            "x86_64" => "x64",
            "aarch64" => "arm64",
            _ => return None,
        };
        let tag = if arch == "arm64" { "osx-arm64-tar" } else { "osx-x64-tar" };
        Some(super::NodeArtifact {
            tag,
            file: format!("node-v{}-darwin-{}.tar.gz", version, arch),
        })
    }

    fn node_candidate_paths(&self) -> Vec<PathBuf> {
        let mut v = vec![
            self.node_bin_after_install(),
            PathBuf::from("/usr/local/bin/node"),
            PathBuf::from("/opt/homebrew/bin/node"),
            PathBuf::from("/usr/bin/node"),
        ];
        let h = home_dir();
        v.push(h.join(".volta").join("bin").join("node"));
        if let Some(p) = super::latest_versioned_node(&h.join(".nvm").join("versions").join("node"), &["bin", "node"]) {
            v.push(p);
        }
        if let Some(p) = super::latest_versioned_node(&h.join(".local").join("share").join("fnm").join("node-versions"), &["installation", "bin", "node"]) {
            v.push(p);
        }
        v
    }

    fn node_bin_after_install(&self) -> PathBuf {
        crate::env::node_install_target().join("bin").join("node")
    }

    fn is_usable_executable(&self, cand: &Path) -> bool {
        cand.is_file()
    }

    fn install_node(&self, file: &Path) -> Result<PathBuf, String> {
        let root = crate::env::node_install_target();
        let staging = root.with_file_name("node.extract");
        let _ = std::fs::remove_dir_all(&staging);
        std::fs::create_dir_all(&staging).map_err(|e| e.to_string())?;
        let mut cmd = Command::new("tar");
        cmd.args(["-xzf"]).arg(file).arg("-C").arg(&staging).arg("--strip-components=1");
        let out = crate::bounded::run(&mut cmd, INSTALL_CMD_TIMEOUT)
            .map_err(|e| format!("无法启动 tar: {}", e))?;
        if !out.success {
            let _ = std::fs::remove_dir_all(&staging);
            return Err(format!("解包 Node 归档失败: {}", out.stderr.trim()));
        }
        let r = super::commit_user_node(&staging, &root, &["bin", "node"]);
        if r.is_err() {
            let _ = std::fs::remove_dir_all(&staging);
        }
        r
    }

    fn core_extra_candidates(&self, names: &[&str], _pkg: Option<&str>) -> Vec<PathBuf> {
        let mut v = Vec::new();
        for name in names {
            v.push(PathBuf::from("/opt/homebrew/bin").join(name));
            v.push(PathBuf::from("/usr/local/bin").join(name));
        }
        v
    }

    fn state_root_default(&self) -> PathBuf {
        crate::brand::state_root_macos(&home_dir())
    }

    fn is_local_fixed_dir(&self, _dir: &Path) -> bool {
        true
    }

    fn has_privilege_channel(&self) -> bool {
        true
    }

    fn node_exe_name(&self) -> &'static str { "node" }
    fn npm_exe_name(&self) -> &'static str { "npm" }
    fn core_exe_names(&self) -> &'static [&'static str] { &["lobox"] }
    fn is_directly_spawnable(&self, _prog: &Path) -> bool { true }
}

impl ServiceControl for Impl {
    fn kind(&self) -> &'static str {
        "process"
    }

    /// 监控器登记表落点（产品状态根下）。**不是** LaunchAgents 下的任何 plist。
    fn definition_path(&self) -> PathBuf {
        crate::env::shell_dir().join("monitor.json")
    }

    /// 登记受管对象（幂等，且内容过时时自愈）：登记的是「产品自己在管谁」，
    /// 不含任何 OS 投递语义 —— 没有 bootstrap、没有 kickstart、没有 RunAtLoad/KeepAlive。
    fn ensure_defined(&self, spec: &LaunchSpec) -> Result<String, String> {
        let path = self.definition_path();
        let (shell, args) = spec.service_command();
        let body = crate::platform::monitor_record_json(
            crate::env::current_api_port(),
            shell,
            args,
            &spec.state_root,
        );
        let existing = std::fs::read_to_string(&path).ok();
        if existing.as_deref() == Some(body.as_str()) {
            return Ok(format!("已存在且为最新 {}", path.display()));
        }
        let is_update = existing.is_some();
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| format!("创建监控登记目录失败: {}", e))?;
        }
        std::fs::write(&path, &body).map_err(|e| format!("写入监控登记失败: {}", e))?;
        Ok(format!(
            "{} {}",
            if is_update { "已更新监控登记" } else { "已建立监控登记" },
            path.display()
        ))
    }

    /// 启动受管对象：产品自己拉起进程（`--run-guard` 稳定入口），不向 launchd 投递。
    fn start(&self) -> Result<(), String> {
        let mut cmd = Command::new(crate::platform::self_exe()?);
        cmd.arg("--run-guard");
        crate::platform::guard_stdio(&mut cmd);
        crate::bounded::prepare(&mut cmd);
        cmd.spawn()
            .map_err(|e| format!("启动受管对象失败: {}", e))
            .map(|_| ())
    }

    /// 停止受管对象：产品自己的进程管理，绝不调用 launchctl bootout。
    fn stop(&self) -> Result<(), String> {
        crate::platform::kill_managed_processes()
    }
}