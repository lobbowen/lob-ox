use std::path::{Path, PathBuf};
use std::process::Command;

use super::service::ServiceControl;
use super::{home_dir, Capabilities, LaunchSpec, Platform};

pub const NAME: &str = "windows";

pub const WATCHDOG_ARGS: &[&str] = &["--watchdog"];

fn ps_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

const INSTALL_CMD_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15 * 60);

fn fresh_dir(dir: &Path) -> Result<(), String> {
    let _ = std::fs::remove_dir_all(dir);
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())
}

fn extract_with_tar(archive: &Path, dest: &Path) -> Result<(), String> {
    fresh_dir(dest)?;
    let (src, dst) = (archive.display().to_string(), dest.display().to_string());
    let out = crate::bounded::run(
        Command::new("tar").args(["-xf", src.as_str(), "-C", dst.as_str()]),
        INSTALL_CMD_TIMEOUT,
    )?;
    if !out.success {
        return Err(out.failure("tar.exe 解包"));
    }
    Ok(())
}

fn extract_with_expand_archive(archive: &Path, dest: &Path) -> Result<(), String> {
    fresh_dir(dest)?;
    let ps = format!(
        "Expand-Archive -LiteralPath {} -DestinationPath {} -Force",
        ps_quote(&archive.display().to_string()),
        ps_quote(&dest.display().to_string())
    );
    let out = crate::bounded::run(
        Command::new("powershell").args(["-NoProfile", "-NonInteractive", "-Command", ps.as_str()]),
        INSTALL_CMD_TIMEOUT,
    )?;
    if !out.success {
        return Err(out.failure("Expand-Archive 解包"));
    }
    Ok(())
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
            privilege_channel: true,
            node_artifact: "zip",
        }
    }

    fn core_platform_tag(&self) -> Option<&'static str> {
        match std::env::consts::ARCH {
            "x86_64" => Some("win-x64"),
            "aarch64" => Some("win-arm64"),
            _ => None,
        }
    }

    fn node_artifact(&self, version: &str) -> Option<super::NodeArtifact> {
                
        let arch = match std::env::consts::ARCH {
            "x86_64" => "x64",
            "aarch64" => "arm64",
            _ => return None,
        };
        let tag = if arch == "arm64" { "win-arm64-zip" } else { "win-x64-zip" };
        Some(super::NodeArtifact {
            tag,
            file: format!("node-v{}-win-{}.zip", version, arch),
        })
    }

    fn node_candidate_paths(&self) -> Vec<PathBuf> {
                
        let exe = "node.exe";
        let mut v: Vec<PathBuf> = vec![self.node_bin_after_install()];
        let env_dir = |var: &str, rest: &[&str]| -> Option<PathBuf> {
            std::env::var(var).ok().map(|base| {
                let mut p = PathBuf::from(base);
                for seg in rest {
                    p = p.join(seg);
                }
                p
            })
        };
        for var in ["ProgramFiles", "ProgramFiles(x86)"] {
            if let Some(p) = env_dir(var, &["nodejs", exe]) {
                v.push(p);
            }
        }
        if let Some(p) = env_dir("ProgramData", &["chocolatey", "bin", exe]) {
            v.push(p);
        }
        if let Some(p) = env_dir("LOCALAPPDATA", &["Programs", "nodejs", exe]) {
            v.push(p);
        }
        if let Some(p) = env_dir("LOCALAPPDATA", &["Volta", "bin", exe]) {
            v.push(p);
        }
        if let Some(p) = env_dir("USERPROFILE", &["scoop", "apps", "nodejs", "current", exe]) {
            v.push(p);
        }
        for base in ["LOCALAPPDATA", "APPDATA"] {
            if let Ok(b) = std::env::var(base) {
                if let Some(p) = super::latest_versioned_node(&PathBuf::from(&b).join("nvm"), &[exe]) {
                    v.push(p);
                }
            }
        }
        if let Ok(nh) = std::env::var("NVM_HOME") {
            if let Some(p) = super::latest_versioned_node(&PathBuf::from(&nh), &[exe]) {
                v.push(p);
            }
            v.push(PathBuf::from(&nh).join(exe));
        }
        if let Ok(link) = std::env::var("NVM_SYMLINK") {
            v.push(PathBuf::from(&link).join(exe));
        }
        v
    }

    fn node_bin_after_install(&self) -> PathBuf {
        crate::env::node_install_target().join(self.node_exe_name())
    }

    fn is_usable_executable(&self, cand: &Path) -> bool {
        if !cand.is_file() {
            return false;
        }
        let low = cand.to_string_lossy().to_ascii_lowercase();
        if low.contains("\\windowsapps\\") {
            return false;
        }
        !std::fs::metadata(cand).map(|m| m.len() == 0).unwrap_or(true)
    }

    fn install_node(&self, file: &Path) -> Result<PathBuf, String> {
                
        let root = crate::env::node_install_target();
        let staging = root.with_file_name("node.extract");
        let extractors: [(&str, fn(&Path, &Path) -> Result<(), String>); 2] = [
            ("tar.exe", extract_with_tar),
            ("Expand-Archive", extract_with_expand_archive),
        ];
        let mut errs: Vec<String> = Vec::new();
        for (name, extract) in extractors {
            let outcome = extract(file, &staging)
                .and_then(|()| super::commit_user_node(&staging, &root, &[self.node_exe_name()]));
            match outcome {
                Ok(installed) => return Ok(installed),
                Err(e) => {
                    crate::update::log(&format!("{} 解包未通过工具链校验：{}", name, e));
                    let _ = std::fs::remove_dir_all(&staging);
                    errs.push(format!("{}：{}", name, e));
                }
            }
        }
        Err(format!("解包 Node 归档失败：{}", errs.join("；")))
    }

    fn core_extra_candidates(&self, names: &[&str], pkg: Option<&str>) -> Vec<PathBuf> {
        let mut v: Vec<PathBuf> = Vec::new();
        let Ok(appdata) = std::env::var("APPDATA") else {
            return v;
        };
        let npm_root = PathBuf::from(&appdata).join("npm");
        for name in names {
            v.push(npm_root.join(name));
        }
        if let Some(p) = pkg {
            v.push(
                npm_root
                    .join("node_modules")
                    .join(p)
                    .join("bin")
                    .join("lobox"),
            );
        }
        v
    }

    fn core_bin_candidates_in_prefix(
        &self,
        prefix: &std::path::Path,
        names: &[&str],
        pkg: Option<&str>,
    ) -> Vec<std::path::PathBuf> {
        let mut v: Vec<std::path::PathBuf> = Vec::new();
        for name in names {
            v.push(prefix.join(format!("{}.cmd", name)));
            v.push(prefix.join(name));
        }
        if let Some(p) = pkg {
            for name in names {
                v.push(prefix.join("node_modules").join(p).join("bin").join(name));
            }
        }
        v
    }

    fn state_root_default(&self) -> PathBuf {
        crate::brand::state_root_windows(
            std::env::var(crate::brand::STATE_ROOT_WIN_BASE_ENV).ok(),
            &home_dir(),
        )
    }

    fn is_local_fixed_dir(&self, dir: &Path) -> bool {
        use std::os::windows::ffi::OsStrExt;
        let w: Vec<u16> = dir.as_os_str().encode_wide().collect();
        if w.len() >= 2 && w[0] == 92 && w[1] == 92 {
            return false;
        }
        if w.len() < 2 || w[1] != 58 {
            return true;
        }
        drive_is_fixed(w[0])
    }

    fn has_privilege_channel(&self) -> bool {
        true
    }

    fn node_exe_name(&self) -> &'static str { "node.exe" }
    fn npm_exe_name(&self) -> &'static str { "npm.cmd" }
    fn core_exe_names(&self) -> &'static [&'static str] {
        &["lobox.exe", "lobox.cmd", "lobox"]
    }

    fn is_directly_spawnable(&self, prog: &Path) -> bool {
        prog.extension()
            .map(|e| e.eq_ignore_ascii_case("exe"))
            .unwrap_or(false)
    }
}

impl ServiceControl for Impl {
    fn kind(&self) -> &'static str {
        "process"
    }

    
    fn definition_path(&self) -> PathBuf {
        crate::platform::monitor_registry_path()
    }

    fn is_defined(&self) -> bool {
        self.definition_path().is_file()
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

#[cfg(target_os = "windows")]
fn drive_is_fixed(letter: u16) -> bool {
    use std::collections::HashMap;
    use std::sync::{Mutex, OnceLock};
    static CACHE: OnceLock<Mutex<HashMap<u16, bool>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Ok(m) = cache.lock() {
        if let Some(v) = m.get(&letter) {
            return *v;
        }
    }
    let mut root = [0u16; 4];
    root[0] = letter;
    root[1] = 58;
    root[2] = 92;
    root[3] = 0;
    extern "system" {
        fn GetDriveTypeW(lp_root_path_name: *const u16) -> u32;
    }
        
    let fixed = unsafe { GetDriveTypeW(root.as_ptr()) } == 3;
    if let Ok(mut m) = cache.lock() {
        m.insert(letter, fixed);
    }
    fixed
}

#[cfg(test)]
mod toolchain_tests {

    use super::*;
    use std::path::{Path, PathBuf};
    use crate::runtime_contract::{npm_cli_js, npm_shim_candidates, probe_npm};

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("dsh-win-{}-{}", tag, std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn only_pe_executables_are_directly_spawnable() {
        let p = crate::platform::current();
        assert!(p.is_directly_spawnable(Path::new("C:\\node\\node.exe")));
        assert!(p.is_directly_spawnable(Path::new("C:\\node\\NPM.EXE")));
        assert!(!p.is_directly_spawnable(Path::new("C:\\node\\npm.cmd")));
        assert!(!p.is_directly_spawnable(Path::new("C:\\node\\npm.bat")));
        assert!(!p.is_directly_spawnable(Path::new("C:\\node\\npm")));
    }

    #[test]
    fn cmd_shim_alone_is_not_reported_as_npm() {
        let d = tmp("cmd-only");
        let node = d.join("node.exe");
        std::fs::write(&node, b"").unwrap();
        std::fs::write(d.join("npm.cmd"), b"@echo off\r\n").unwrap();
        assert!(
            probe_npm(&node, &d).is_none(),
            "只剩不可直接执行的垫片时必须判为不就绪，绝不把 .cmd 交给 Command::new"
        );
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn official_layout_resolves_to_node_plus_npm_cli_js() {
        let d = tmp("official");
        let node = d.join("node.exe");
        std::fs::write(&node, b"").unwrap();
        for extra in ["npm.cmd", "npm"] {
            std::fs::write(d.join(extra), b"").unwrap();
        }
        let cli = npm_cli_js(&d);
        std::fs::create_dir_all(cli.parent().unwrap()).unwrap();
        std::fs::write(&cli, b"").unwrap();
        let (prog, args) = probe_npm(&node, &d).expect("完整树应解析出 npm");
        assert_eq!(prog, node, "npm 必须由同一 node.exe 承载");
        assert_eq!(args, vec![cli.display().to_string()]);
        assert!(crate::platform::current().is_directly_spawnable(&prog));
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn commit_refuses_to_replace_a_good_install_with_a_truncated_tree() {
        let staging = tmp("trunc-staging");
        let inner = staging.join("node-v22.12.0-win-x64");
        std::fs::create_dir_all(&inner).unwrap();
        std::fs::write(inner.join("node.exe"), b"").unwrap();
        std::fs::write(inner.join("npm.cmd"), b"@echo off\r\n").unwrap();
        let root = tmp("trunc-root").join("node");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("marker"), "既有安装").unwrap();
        let err = crate::platform::commit_user_node(&staging, &root, &["node.exe"])
            .expect_err("残缺树必须被拒绝");
        assert!(err.contains("npm"), "错误要指出缺的是 npm：{}", err);
        assert!(root.join("marker").exists(), "拒绝半成品时不得动既有安装");
        let _ = std::fs::remove_dir_all(staging);
        let _ = std::fs::remove_dir_all(root.parent().unwrap());
    }

    #[test]
    fn every_shim_candidate_name_is_a_plain_file_name() {
        let bin = Path::new("C:\\node");
        for p in npm_shim_candidates(bin) {
            assert_eq!(p.parent(), Some(bin), "候选必须是 bin 目录内的裸文件名");
            assert!(p.file_name().is_some());
        }
    }

    #[test]
    #[ignore = "联网下载官方 Node 归档（约 30MB），仅由 CI 的 Windows leg 执行"]
    fn official_artifact_installs_usable_npm() {
        let home = tmp("e2e");
        std::env::set_var("DSH_SUPERVISOR_HOME", &home);
        let choice = crate::node::latest_lts().expect("镜像发现失败");
        let dl = home.join("dl");
        let beats: std::sync::Arc<std::sync::Mutex<Vec<(u64, Option<u64>)>>> = Default::default();
        let sink = {
            let b = beats.clone();
            move |done: u64, total: Option<u64>| {
                b.lock().unwrap_or_else(|e| e.into_inner()).push((done, total));
            }
        };
        let archive = crate::node::download_verified(
            &choice.version,
            &choice.file,
            &dl,
            Some(choice.source.as_str()),
            &sink,
        )
        .expect("官方归档下载失败");
        let b = beats.lock().unwrap_or_else(|e| e.into_inner()).clone();
        assert!(b.len() >= 2, "下载全程没有字节心跳（只报一次=没有进度）：{} 次", b.len());
        let size = std::fs::metadata(&archive).expect("stat 归档失败").len();
        let (last_done, last_total) = *b.last().expect("至少一次心跳");
        assert_eq!(last_done, size, "收尾进度 {} ≠ 落盘大小 {}", last_done, size);
        if let Some(t) = last_total {
            assert_eq!(t, size, "服务端声称的 Content-Length 与真实大小不符：{}", t);
        }
        assert!(
            b.iter().all(|(got, _)| *got <= size),
            "心跳报出了比归档本身还大的字节量：{:?}",
            b.iter().map(|x| x.0).collect::<Vec<_>>()
        );
        let node = crate::platform::current()
            .install_node(&archive)
            .expect("生产解包路径失败（这一步的报错就是面板会显示给用户的那句）");
        let rt = crate::runtime_contract::derive_usable(&node, &choice.version)
            .unwrap_or_else(|| panic!("{} 解出来后 npm 不可用：node={}", choice.version, node.display()));
        let v = rt.npm_version.clone().expect("真实执行过 npm，必须回读到版本号");
        assert!(!v.is_empty());
        
        
        let global_root = crate::env::global_install_root();
        assert!(
            node.starts_with(&global_root) || node.starts_with(&home),
            "安装必须落在全局安装根（或老布局状态根）下，实际：{}",
            node.display()
        );
        let _ = std::fs::remove_dir_all(&home);
    }
}

#[cfg(test)]
mod definition_tests {
        
        
        
    #[test]
    fn windows_monitor_outputs_never_reference_os_service_mechanisms() {
        let shell = std::path::Path::new(r"C:\Program Files\lobox\lobox-shell.exe");
        let json = crate::platform::monitor_record_json(
            37360,
            shell,
            &["--run-guard"],
            std::path::Path::new(r"C:\state"),
        );
        let mut all = json.clone();
        all.push_str(&crate::platform::service_exec_line(shell, &["--run-guard"]));
        for banned in ["schtasks", "CurrentVersion\\Run", "/TN", "/SC", "/TR", "LaunchAgents", "systemctl"] {
            assert!(
                !all.to_lowercase().contains(&banned.to_lowercase()),
                "服务管理器产物不得出现 OS 服务机制（{}）：{}",
                banned,
                all
            );
        }
    }
}
