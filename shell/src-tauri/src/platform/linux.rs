use std::path::{Path, PathBuf};
use std::process::Command;

use super::service::ServiceControl;
use super::{home_dir, Capabilities, LaunchSpec, Platform};

pub const NAME: &str = "linux";

const INSTALL_CMD_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15 * 60);

pub const PRIVILEGE_COMMANDS: [&str; 2] = ["pkexec", "sudo"];

pub fn find_privilege_command() -> Option<&'static str> {
    let path = std::env::var_os("PATH")?;
    let dirs: Vec<PathBuf> = std::env::split_paths(&path).collect();
    PRIVILEGE_COMMANDS
        .iter()
        .find(|c| dirs.iter().any(|d| d.join(c).is_file()))
        .copied()
}

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
            privilege_channel: self.has_privilege_channel(),
            node_artifact: "tar.gz",
        }
    }

    fn core_platform_tag(&self) -> Option<&'static str> {
        match std::env::consts::ARCH {
            "x86_64" => Some("linux-x64"),
            "aarch64" => Some("linux-arm64"),
            _ => None,
        }
    }

    fn node_artifact(&self, version: &str) -> Option<super::NodeArtifact> {
        let arch = match std::env::consts::ARCH {
            "x86_64" => "x64",
            "aarch64" => "arm64",
            _ => return None,
        };
        let tag = if arch == "arm64" { "linux-arm64" } else { "linux-x64" };
        Some(super::NodeArtifact {
            tag,
                        
            file: format!("node-v{}-linux-{}.tar.gz", version, arch),
        })
    }

    fn node_candidate_paths(&self) -> Vec<PathBuf> {
        let mut v = vec![
            self.node_bin_after_install(),
            PathBuf::from("/usr/local/bin/node"),
            PathBuf::from("/usr/bin/node"),
            PathBuf::from("/bin/node"),
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

    fn core_extra_candidates(&self, _names: &[&str], _pkg: Option<&str>) -> Vec<PathBuf> {
        Vec::new()
    }

    fn is_local_fixed_dir(&self, _dir: &Path) -> bool {
        true
    }

    fn has_privilege_channel(&self) -> bool {
        find_privilege_command().is_some()
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

    
    fn definition_path(&self) -> PathBuf {
        crate::platform::monitor_registry_path()
    }

    
    
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
        Ok(crate::platform::monitor_ensure_message(
            is_update,
            &path,
            shell,
            args,
        ))
    }

    
    fn start(&self) -> Result<(), String> {
        let mut cmd = Command::new(crate::platform::self_exe()?);
        cmd.arg("--run-guard");
        crate::platform::guard_stdio(&mut cmd);
        crate::bounded::prepare(&mut cmd);
        cmd.spawn()
            .map_err(|e| format!("启动受管对象失败: {}", e))
            .map(|_| ())
    }

    
    
    fn stop(&self) -> Result<(), String> {
        crate::platform::kill_managed_processes()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a2_find_privilege_command_respects_path() {
        let saved = std::env::var_os("PATH");
        std::env::set_var("PATH", "");
        let none = find_privilege_command();
        match &saved {
            Some(p) => std::env::set_var("PATH", p),
            None => std::env::remove_var("PATH"),
        }
        assert!(none.is_none(), "A-2 FAIL 空 PATH 下仍报告有提权通道: {:?}", none);

        let dir = std::env::temp_dir().join(format!("dsh-priv-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let fake = dir.join("pkexec");
        std::fs::write(&fake, b"#!/bin/sh\n").unwrap();
        std::env::set_var("PATH", dir.display().to_string());
        let got = find_privilege_command();
        match &saved {
            Some(p) => std::env::set_var("PATH", p),
            None => std::env::remove_var("PATH"),
        }
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(got, Some("pkexec"), "A-2 FAIL 未按 PATH 命中伪造的 pkexec");
    }
}