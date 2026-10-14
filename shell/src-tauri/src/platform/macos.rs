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
    fn extract_archive(&self, archive: &std::path::Path, dest: &std::path::Path) -> Result<std::path::PathBuf, String> {
        let _ = std::fs::remove_dir_all(dest);
        std::fs::create_dir_all(dest).map_err(|e| e.to_string())?;
        let mut cmd = Command::new("tar");
        cmd.args(["-xzf"]).arg(archive).arg("-C").arg(dest);
        let out = crate::bounded::run(&mut cmd, std::time::Duration::from_secs(300))
            .map_err(|e| e.to_string())?;
        // bounded::run 的 code 是 Option<i32>，不能直接与 0 比较（E0308）也不能
        // 直接格式化（E0277）；success 字段本身即「退出码为 0」的判定。
        if !out.success {
            return Err(format!(
                "tar 解压失败（exit={:?}）: {}",
                out.code,
                crate::bounded::exit_code_label(Some(out.code.unwrap_or(-1)))
            ));
        }
        Ok(dest.to_path_buf())
    }
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
    fn core_exe_names(&self) -> &'static [&'static str] {
        crate::brand::core_bin_names()
    }
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
        // monitor.json 是跨进程契约文件，必须走 atomic_write（tmp + rename）。
    // 此前这里是裸 std::fs::write：rename 失败/断电会留半文件，而 is_defined()
    // 只判 is_file()，半文件会被当成「已登记」。
    crate::atomic_write::write(&path, &body).map_err(|e| format!("写入监控登记失败: {}", e))?;
        Ok(crate::platform::monitor_ensure_message(
            is_update,
            &path,
            shell,
            args,
        ))
    }

    
    fn stop(&self) -> Result<(), String> {
        crate::platform::kill_managed_processes()
    }
}