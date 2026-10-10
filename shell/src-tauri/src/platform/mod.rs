pub mod service;

pub const SVC_QUICK: std::time::Duration = std::time::Duration::from_secs(8);
pub const SVC_NORMAL: std::time::Duration = std::time::Duration::from_secs(10);

pub fn home_dir() -> std::path::PathBuf {
    std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| std::path::PathBuf::from("."))
}

pub fn user_name() -> String {
    std::env::var("USER")
        .or_else(|_| std::env::var("USERNAME"))
        .unwrap_or_else(|_| "user".into())
}

pub fn system_proxy() -> Option<String> {
    #[cfg(target_os = "windows")]
    let v = windows_system_proxy();
    #[cfg(target_os = "macos")]
    let v = macos_system_proxy();
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    let v: Option<String> = None;
    v
}

#[cfg(target_os = "windows")]
fn windows_system_proxy() -> Option<String> {
    use std::process::Command;
    let query = |name: &str| -> Option<String> {
        let mut cmd = Command::new("reg");
        cmd.args([
            "query",
            "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings",
            "/v",
            name,
        ]);
        let out = crate::bounded::run(&mut cmd, SVC_QUICK).ok()?;
        let line = out.stdout.lines().find(|l| l.contains(name))?;
        line.split_whitespace().last().map(|x| x.to_string())
    };
    let enabled = query("ProxyEnable").map(|v| v.ends_with('1')).unwrap_or(false);
    if !enabled {
        return None;
    }
    let server = query("ProxyServer")?;
    let hostport = if server.contains('=') {
        server
            .split(';')
            .find_map(|p| p.split_once('='))
            .filter(|(k, _)| k.eq_ignore_ascii_case("https") || k.eq_ignore_ascii_case("http"))
            .map(|(_, v)| v.to_string())?
    } else {
        server
    };
    if hostport.trim().is_empty() {
        return None;
    }
    Some(if hostport.contains("://") { hostport } else { format!("http://{}", hostport) })
}

#[cfg(target_os = "macos")]
fn macos_system_proxy() -> Option<String> {
    use std::process::Command;
    let mut cmd = Command::new("scutil");
    cmd.arg("--proxy");
    let out = crate::bounded::run(&mut cmd, SVC_QUICK).ok()?;
    let s = out.stdout;
    let field = |k: &str| -> Option<String> {
        s.lines()
            .find(|l| l.trim_start().starts_with(k))
            .and_then(|l| l.split(':').nth(1))
            .map(|v| v.trim().to_string())
    };
    for (enable, host, port) in [
        ("HTTPSEnable", "HTTPSProxy", "HTTPSPort"),
        ("HTTPEnable", "HTTPProxy", "HTTPPort"),
    ] {
        if field(enable).as_deref() == Some("1") {
            if let Some(h) = field(host) {
                let p = field(port).unwrap_or_else(|| "80".into());
                return Some(format!("http://{}:{}", h, p));
            }
        }
    }
    None
}

pub fn commit_user_node(
    staging: &std::path::Path,
    root: &std::path::Path,
    node_rel: &[&str],
) -> Result<std::path::PathBuf, String> {
    let probe = |b: &std::path::Path| -> std::path::PathBuf {
        node_rel.iter().fold(b.to_path_buf(), |p, s| p.join(*s))
    };
    let mut base = staging.to_path_buf();
    if !probe(&base).is_file() {
        if let Ok(entries) = std::fs::read_dir(&base) {
            let dirs: Vec<std::path::PathBuf> = entries
                .filter_map(|e| e.ok().map(|e| e.path()))
                .filter(|p| p.is_dir())
                .collect();
            if dirs.len() == 1 {
                base = dirs[0].clone();
            }
        }
    }
    let found = probe(&base);
    if !found.is_file() {
        return Err(format!("解包后未找到 Node 可执行（{}）", found.display()));
    }
    let bin_dir = found.parent().unwrap_or(base.as_path()).to_path_buf();
        
    if crate::runtime_contract::probe_npm(&found, &bin_dir).is_none() {
        return Err(format!(
            "解包后的归档不含可用 npm（{}）。拒绝落定半成品。",
            crate::runtime_contract::npm_search_summary(&bin_dir)
        ));
    }
    if let Some(parent) = root.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let _ = std::fs::remove_dir_all(root);
    if let Err(e) = std::fs::rename(&base, root) {
        return Err(format!("落定 {} 失败: {}", root.display(), e));
    }
    let _ = std::fs::remove_dir_all(staging);
    let installed = probe(root);
    if !installed.is_file() {
        return Err(format!("{} 未就位", installed.display()));
    }
    Ok(installed)
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct Capabilities {
    pub platform: &'static str,
    pub native_service: bool,
    pub privilege_channel: bool,
    pub node_artifact: &'static str,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NodeArtifact {
    pub tag: &'static str,
    pub file: String,
}

pub fn external_path(p: &std::path::Path) -> std::path::PathBuf {
    const VERBATIM: &str = concat!(r"\\?", "\\");
    const VERBATIM_UNC: &str = concat!(r"\\?\UNC", "\\");
    const DEVICE: &str = concat!(r"\\.", "\\");
    let s = p.to_string_lossy();
        
    if s.len() >= VERBATIM_UNC.len()
        && s.is_char_boundary(VERBATIM_UNC.len())
        && s[..VERBATIM_UNC.len()].eq_ignore_ascii_case(VERBATIM_UNC)
    {
        return std::path::PathBuf::from(format!(r"\\{}", &s[VERBATIM_UNC.len()..]));
    }
    for prefix in [VERBATIM, DEVICE] {
        if let Some(rest) = s.strip_prefix(prefix) {
            return std::path::PathBuf::from(rest);
        }
    }
    p.to_path_buf()
}

pub fn self_exe() -> Result<std::path::PathBuf, String> {
    let p = std::env::current_exe().map_err(|e| format!("无法取得壳自身可执行路径：{}", e))?;
    Ok(external_path(&p))
}

pub fn guard_stdio(cmd: &mut std::process::Command) {
    use std::process::Stdio;
    let (out, err) = guard_stdio_streams(crate::update::guard_log_file());
    cmd.stdin(Stdio::null()).stdout(out).stderr(err);
}

fn guard_stdio_streams(
    log: Option<std::fs::File>,
) -> (std::process::Stdio, std::process::Stdio) {
    use std::process::Stdio;
    match log {
                
        Some(f) => match f.try_clone() {
            Ok(out) => (Stdio::from(out), Stdio::from(f)),
            Err(_) => (Stdio::null(), Stdio::from(f)),
        },
        None => (Stdio::null(), Stdio::null()),
    }
}

#[derive(Clone, Debug)]
pub struct LaunchSpec {
    pub node: std::path::PathBuf,
    pub guard: std::path::PathBuf,
    pub env_path: String,
        
    pub state_root: std::path::PathBuf,
        
    pub shell: std::path::PathBuf,
}

impl LaunchSpec {
        
    pub fn from_runtime(
        rt: &crate::runtime_contract::NodeRuntime,
        guard: std::path::PathBuf,
    ) -> Result<Self, String> {
        Ok(LaunchSpec {
            node: external_path(&rt.node),
            guard: external_path(&guard),
            env_path: crate::runtime_contract::env_path(&rt.node_bin_dir),
            state_root: external_path(&crate::env::state_root()),
            shell: self_exe()?,
        })
    }

        
    pub fn service_command(&self) -> (&std::path::Path, &'static [&'static str]) {
        (self.shell.as_path(), &["--run-guard"])
    }
}

pub fn service_exec_line(shell: &std::path::Path, args: &[&str]) -> String {
    let mut s = format!("\"{}\"", shell.display());
    for a in args {
        s.push(' ');
        s.push_str(a);
    }
    s
}

pub fn monitor_registry_path() -> std::path::PathBuf {
    crate::env::shell_dir().join("monitor.json")
}

pub fn monitor_ensure_message(
    is_update: bool,
    path: &std::path::Path,
    shell: &std::path::Path,
    args: &[&str],
) -> String {
    format!(
        "{} {} -> {}",
        if is_update { "已更新监控登记" } else { "已建立监控登记" },
        path.display(),
        service_exec_line(shell, args)
    )
}

pub fn monitor_record_json(
    port: u16,
    shell: &std::path::Path,
    args: &[&str],
    state_root: &std::path::Path,
) -> String {
    let mut s = String::new();
    s.push_str("{\n  \"schema\": 1,\n");
    s.push_str(&format!("  \"port\": {},\n", port));
    s.push_str(&format!("  \"command\": {:?},\n", service_exec_line(shell, args)));
    s.push_str(&format!("  \"stateRoot\": {:?}\n", state_root.display().to_string()));
    s.push_str("}\n");
    s
}

pub fn kill_managed_processes() -> Result<(), String> {
    #[cfg(windows)]
    {
        let ps = format!(
            "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object {{ $_.CommandLine -like '{}' }} | ForEach-Object {{ Stop-Process -Id $_.ProcessId -Force }}",
            crate::brand::PROC_MATCH_GUARD
        );
        let out = crate::bounded::run(
            std::process::Command::new("powershell").args([
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                &ps,
            ]),
            SVC_NORMAL,
        );
        return match out {
            Ok(o) if o.success => Ok(()),
            Ok(o) => Err(format!("终止受管对象进程失败: {}", o.stderr.trim())),
            Err(e) => Err(format!("终止受管对象进程超时/失败: {}", e)),
        };
    }
    #[cfg(not(windows))]
    {
        let script = managed_stop_script();
        let out = crate::bounded::run(
            std::process::Command::new("sh").args(["-c", &script]),
            SVC_NORMAL,
        );
        match out {
            Ok(_) => Ok(()),
            Err(e) => Err(format!("终止受管对象进程超时/失败: {}", e)),
        }
    }
}

pub fn managed_stop_script() -> String {
    let pat = unix_proc_match_pattern();
    let me = std::process::id();
    format!(
        "for p in $(ps -eo pid=,comm=,args= | awk '$2 ~ /(^|\\/)node$/ && $0 ~ /{}/ {{print $1}}'); do [ \"$p\" = \"{}\" ] || kill \"$p\" 2>/dev/null || true; done; exit 0",
        pat, me
    )
}

pub fn unix_proc_match_pattern() -> String {
    let raw = crate::brand::PROC_MATCH_GUARD;
    let core = raw.trim_matches('*');
    let mut out = String::new();
    for c in core.chars() {
        if regex_meta().contains(&c) {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

fn regex_meta() -> [char; 14] {
    ['.', '\\', '+', '?', '[', ']', '^', '$', '(', ')', '{', '}', '|', '/']
}

#[cfg(unix)]
pub fn exec_guard(spec: &LaunchSpec) -> Result<(), String> {
    use std::os::unix::process::CommandExt;
    let mut cmd = std::process::Command::new(&spec.node);
    cmd.arg(&spec.guard)
        .arg("daemon")
        .env("PATH", &spec.env_path)
        .env("DSH_SUPERVISOR_HOME", &spec.state_root);
    guard_stdio(&mut cmd);
    Err(format!("exec 守卫失败: {}", cmd.exec()))
}

#[cfg(windows)]
pub fn exec_guard(spec: &LaunchSpec) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    let is_shim = spec
        .guard
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| {
            let e = e.to_ascii_lowercase();
            e == "cmd" || e == "bat"
        })
        .unwrap_or(false);
    let mut cmd = if is_shim {
        let mut c = std::process::Command::new("cmd");
        c.arg("/C").arg(&spec.guard).arg("daemon");
        c
    } else {
        let mut c = std::process::Command::new(&spec.node);
        c.arg(&spec.guard).arg("daemon");
        c
    };
    cmd.env("PATH", &spec.env_path)
        .env("DSH_SUPERVISOR_HOME", &spec.state_root);
        
    guard_stdio(&mut cmd);
    cmd.creation_flags(0x0000_0008 | 0x0800_0000);
    cmd.spawn().map_err(|e| format!("启动守卫失败: {}", e))?;
    Ok(())
}

pub trait Platform: Send + Sync {
    fn name(&self) -> &'static str;
    fn service(&self) -> &'static dyn service::ServiceControl;
    fn capabilities(&self) -> Capabilities;

        
    fn core_platform_tag(&self) -> Option<&'static str>;

    fn node_artifact(&self, version: &str) -> Option<NodeArtifact>;

        
    fn is_local_fixed_dir(&self, dir: &std::path::Path) -> bool;

    fn node_candidate_paths(&self) -> Vec<std::path::PathBuf>;

        
    fn core_extra_candidates(&self, names: &[&str], pkg: Option<&str>) -> Vec<std::path::PathBuf>;

        
    fn core_bin_candidates_in_prefix(
        &self,
        prefix: &std::path::Path,
        names: &[&str],
        _pkg: Option<&str>,
    ) -> Vec<std::path::PathBuf> {
        names.iter().map(|n| prefix.join("bin").join(n)).collect()
    }

    fn node_bin_after_install(&self) -> std::path::PathBuf;

    fn is_usable_executable(&self, cand: &std::path::Path) -> bool;

    fn state_root_default(&self) -> std::path::PathBuf {
        crate::brand::state_root_linux(
            std::env::var_os(crate::brand::STATE_ROOT_LINUX_XDG_ENV),
            &home_dir(),
        )
    }

        
    fn install_node(&self, file: &std::path::Path) -> Result<std::path::PathBuf, String>;

    fn has_privilege_channel(&self) -> bool;

    fn node_exe_name(&self) -> &'static str;

        
    fn npm_exe_name(&self) -> &'static str;

    fn core_exe_names(&self) -> &'static [&'static str];

        
    fn is_directly_spawnable(&self, prog: &std::path::Path) -> bool;
}

#[cfg(target_os = "linux")]
pub(crate) mod linux;
#[cfg(target_os = "linux")]
pub(crate) use linux as imp;

#[cfg(target_os = "macos")]
pub(crate) mod macos;
#[cfg(target_os = "macos")]
pub(crate) use macos as imp;

#[cfg(target_os = "windows")]
pub(crate) mod windows;
#[cfg(target_os = "windows")]
pub(crate) use windows as imp;

pub(crate) mod unsupported;
#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
pub(crate) use unsupported as imp;

pub fn current() -> &'static dyn Platform {
    imp::platform()
}

pub fn service() -> &'static dyn service::ServiceControl {
    imp::service()
}

pub fn capabilities() -> Capabilities {
    current().capabilities()
}

pub fn latest_versioned_node(root: &std::path::Path, suffix: &[&str]) -> Option<std::path::PathBuf> {
    let rd = std::fs::read_dir(root).ok()?;
    let mut best: Option<(Vec<u64>, std::path::PathBuf)> = None;
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        let trimmed = name.trim_start_matches('v');
        let nums: Vec<u64> = trimmed.split('.').map_while(|x| x.parse::<u64>().ok()).collect();
        if nums.is_empty() {
            continue;
        }
        let mut full = e.path();
        for seg in suffix {
            full = full.join(seg);
        }
        let better = match &best {
            None => true,
            Some((bv, _)) => nums > *bv,
        };
        if better {
            best = Some((nums, full));
        }
    }
    best.map(|(_, p)| p)
}

pub fn matrix_text() -> String {
    let c = capabilities();
    let plat = current();
    let svc = plat.service();
    let def = svc.definition_path();
    [
        format!("platform={}", plat.name()),
        format!("platform_field={}", c.platform),
        format!("native_service={}", c.native_service),
        format!("service_kind={}", svc.kind()),
        format!("privilege_channel={}", c.privilege_channel),
        format!("node_artifact={}", c.node_artifact),
        format!("definition_path={}", def.display()),
        format!("definition_exists={}", def.is_file()),
    ]
    .join(" | ")
}

#[cfg(test)]
mod tests {
        
    #[test]
    fn core_platform_tag_matches_build_target() {
        let got = super::current().core_platform_tag();
        let want = match (std::env::consts::OS, std::env::consts::ARCH) {
            ("linux", "x86_64") => Some("linux-x64"),
            ("linux", "aarch64") => Some("linux-arm64"),
            ("macos", "x86_64") => Some("darwin-x64"),
            ("macos", "aarch64") => Some("darwin-arm64"),
            ("windows", "x86_64") => Some("win-x64"),
            ("windows", "aarch64") => Some("win-arm64"),
            _ => None,
        };
        assert_eq!(got, want, "core_platform_tag 必须与构建 target 一致");
    }

        
        
        
    #[test]
    fn monitor_outputs_never_reference_os_service_mechanisms() {
        let shell = std::path::Path::new("/opt/My App/lobox-shell");
        let json = super::monitor_record_json(37360, shell, &["--run-guard"], std::path::Path::new("/state"));
        let mut all = json.clone();
        all.push_str(&super::managed_stop_script());
        all.push_str(&super::service_exec_line(shell, &["--run-guard"]));
        for banned in ["schtasks", "systemctl", "systemd", "launchctl", "launchd", "LaunchAgents", ".plist"] {
            assert!(
                !all.to_lowercase().contains(&banned.to_lowercase()),
                "服务管理器产物不得出现 OS 服务机制（{}）：{}",
                banned,
                all
            );
        }
    }

        
        
    #[test]
    fn monitor_record_carries_the_adopted_port_not_a_hardcoded_one() {
        let j = super::monitor_record_json(39111, std::path::Path::new("/s"), &["--run-guard"], std::path::Path::new("/state"));
        let v: serde_json::Value = serde_json::from_str(&j).expect("登记表必须是合法 JSON");
        assert_eq!(v.get("port").and_then(|x| x.as_u64()), Some(39111), "端口必须照抄接管时探测值: {}", j);
        assert_eq!(v.get("schema").and_then(|x| x.as_u64()), Some(1));
    }

        
        
    #[test]
    fn managed_stop_script_targets_only_managed_node_and_excludes_self() {
        let s = super::managed_stop_script();
        assert!(s.contains("comm=") && s.contains("node"), "必须按镜像名钉死 node: {}", s);
        assert!(s.contains(&super::unix_proc_match_pattern()), "必须带产品名匹配串: {}", s);
        assert!(s.contains(&std::process::id().to_string()), "必须排除本进程: {}", s);
        assert!(!s.contains("pkill"), "不得用 pkill（无法排除自身与壳）: {}", s);
    }

        
        
    #[test]
    fn unix_proc_match_pattern_strips_wmi_wildcards() {
        let p = super::unix_proc_match_pattern();
        assert!(!p.contains('*'), "不得残留 WMI 通配符: {}", p);
        assert!(p.contains("lobox"), "必须保留产品名字面量: {}", p);
    }

        
        
        
    #[test]
    fn monitor_ensure_message_carries_the_stable_entry() {
        let shell = std::path::Path::new("/opt/My App/lobox-shell");
        let m = super::monitor_ensure_message(false, std::path::Path::new("/state/monitor.json"), shell, &["--run-guard"]);
        assert!(m.contains("lobox-shell"), "缺壳路径: {}", m);
        assert!(m.contains("--run-guard"), "缺稳定入口参数: {}", m);
        assert!(m.contains("已建立监控登记"), "缺动词: {}", m);
        let u = super::monitor_ensure_message(true, std::path::Path::new("/state/monitor.json"), shell, &["--run-guard"]);
        assert!(u.contains("已更新监控登记"), "更新态文案: {}", u);
    }
}

#[cfg(test)]
mod launch_spec_tests {
    use super::*;

    fn spec_with(shell: &str) -> LaunchSpec {
        LaunchSpec {
            node: std::path::PathBuf::from("/NODE SENTINEL/node"),
            guard: std::path::PathBuf::from("/GUARD SENTINEL/guard"),
            env_path: String::new(),
            state_root: std::path::PathBuf::from("/state"),
            shell: std::path::PathBuf::from(shell),
        }
    }

    #[test]
    fn service_command_is_shell_run_guard() {
        let s = spec_with("/opt/x/lobox");
        let (shell, args) = s.service_command();
        assert_eq!(shell, std::path::Path::new("/opt/x/lobox"));
        assert_eq!(args, &["--run-guard"]);
    }

    #[test]
    fn service_exec_line_quotes_shell_and_has_no_volatile_paths() {
        let s = spec_with("/home/John Smith/lobox");
        let (shell, args) = s.service_command();
        let line = service_exec_line(shell, args);
        assert_eq!(line, "\"/home/John Smith/lobox\" --run-guard");
        assert!(!line.contains("NODE SENTINEL") && !line.contains("GUARD SENTINEL"),
            "服务定义不得含 node/guard 路径：{}", line);
    }

    fn ext(s: &str) -> String {
        external_path(std::path::Path::new(s)).to_string_lossy().into_owned()
    }

    #[test]
    fn external_path_strips_verbatim_drive_and_device_prefix() {
        assert_eq!(ext(r"\\?\C:\Users\x\dsh.exe"), r"C:\Users\x\dsh.exe");
        assert_eq!(ext(r"\\.\C:\x"), r"C:\x");
    }

    #[test]
    fn external_path_strips_verbatim_unc_case_insensitively() {
        assert_eq!(ext(r"\\?\UNC\srv\share\x"), r"\\srv\share\x");
        assert_eq!(ext(r"\\?\unc\srv\share"), r"\\srv\share");
    }

    #[test]
    fn external_path_leaves_clean_and_unix_paths_untouched() {
        for p in [r"C:\Users\x", "/home/u/bin/lobox", ""] {
            assert_eq!(ext(p), p, "不应改写: {}", p);
        }
    }

    #[test]
    fn external_path_accepts_multibyte_without_splitting_char_boundary() {
        let p = r"\\?\UNC\srv\中文共享\x";
        assert_eq!(ext(p), r"\\srv\中文共享\x");
        assert_eq!(ext(r"\\?\C:\用户\x"), r"C:\用户\x");
    }

    #[test]
    fn self_exe_is_normalized_and_reports_failure() {
        let got = self_exe().expect("测试环境应能取得壳自身路径");
        assert!(got.is_absolute(), "壳路径必须是绝对路径: {}", got.display());
        assert!(
            !got.to_string_lossy().starts_with(r"\\?\"),
            "壳路径不得带 verbatim 前缀（外部工具不接受该形态，写进服务定义后失败无从归因）: {}",
            got.display()
        );
    }

    #[test]
    fn guard_streams_keep_child_output_and_fall_back_to_null() {
        let dir = std::env::temp_dir().join(format!("dsh-guardio-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let f = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(dir.join("guard.log"))
            .unwrap();

                
        let (out, err) = guard_stdio_streams(Some(f));
        spawn_marker_child(out, err).wait().expect("子进程应能跑完");
        let log = std::fs::read_to_string(dir.join("guard.log")).unwrap_or_default();
        assert!(
            log.contains("dsh-mark-out") && log.contains("dsh-mark-err"),
            "日志可用时两条流都得进文件: {log:?}"
        );

        let (out, err) = guard_stdio_streams(None);
        spawn_marker_child(out, err).wait().expect("无日志时也必须能拉起");
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn spawn_marker_child(
        out: std::process::Stdio,
        err: std::process::Stdio,
    ) -> std::process::Child {
        let mut c = std::process::Command::new(if cfg!(windows) { "cmd" } else { "/bin/sh" });
        if cfg!(windows) {
            c.args(["/C", "echo dsh-mark-out & echo dsh-mark-err>&2"]);
        } else {
            c.args(["-c", "echo dsh-mark-out; echo dsh-mark-err >&2"]);
        }
        c.stdin(std::process::Stdio::null()).stdout(out).stderr(err).spawn().expect("spawn 标记子进程")
    }
}