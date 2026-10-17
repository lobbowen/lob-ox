pub mod service;

pub const SVC_QUICK: std::time::Duration = std::time::Duration::from_secs(8);
pub const SVC_NORMAL: std::time::Duration = std::time::Duration::from_secs(10);

// 用户主目录。单一实现在 env::home（兜底 /tmp）——
// 此前这里另有一份，兜底值是 "."：相对路径会让 state_root 随 cwd 漂移，
// 在 HOME/USERPROFILE 双缺的机器上属潜在缺陷。保留 env::home 的那份，
// 此处只做转发，避免两套 home 解析给出不同答案。
pub fn home_dir() -> std::path::PathBuf {
    crate::env::home()
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

/// `--run-guard` 的一次性凭据（J-2 第 3 项）。
///
/// 背景：`--run-guard` 是三条 spawn 路收敛的入口，但它自身**不验任何凭据** ——
/// 本机任意进程都能跑 `lobox-shell --run-guard` 拉一个内核起来（双守卫的第三种
/// 成因，也是「删 Lобot 任务计划」之前必须先补的阻挡）。
///
/// 设计约束（架构侧给的）：
///   · **每次 spawn 新生成，不能学 `mgmt.rs` 的 `OnceLock` 进程级单例** ——
///     同一个壳会 spawn 多次，进程级单例会让第二次复用同一值，退化成「设了就算」；
///   · 熵源复用 `mgmt.rs` 的范式（`BCryptGenRandom` / `/dev/urandom`）+ 常量时间比较；
///   · **fail-closed**：取不到熵就拒绝启动，不退化成可预测种子。
///
/// 传递方式：经环境变量交给子进程，`cli_run_guard` 收下即验、验完即从环境移除。
pub fn spawn_token() -> Result<String, String> {
    let mut seed = [0u8; 32];
    let mut ok = false;
    unsafe {
        #[cfg(target_os = "windows")]
        {
            extern "system" {
                fn BCryptGenRandom(hAlgorithm: *mut core::ffi::c_void, pbBuffer: *mut u8, cbBuffer: u32, dwFlags: u32) -> i32;
            }
            const BCRYPT_USE_SYSTEM_PREFERRED_RNG: u32 = 0x00000002;
            ok = BCryptGenRandom(
                core::ptr::null_mut(),
                seed.as_mut_ptr(),
                seed.len() as u32,
                BCRYPT_USE_SYSTEM_PREFERRED_RNG,
            ) == 0;
        }
        #[cfg(not(target_os = "windows"))]
        {
            if let Ok(mut f) = std::fs::File::open("/dev/urandom") {
                use std::io::Read;
                ok = f.read_exact(&mut seed).is_ok();
            }
        }
    }
    if !ok {
        return Err("系统熵源不可用：拒绝以可预测种子派生 --run-guard 凭据（fail-closed）".to_string());
    }
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(seed);
    h.update(b"lobox-run-guard:");
    h.update(std::process::id().to_string().as_bytes());
    Ok(hex::encode(&h.finalize()[..24]))
}

/// 凭据经哪个环境变量传给子进程。
///
/// 名字**不在** `shared-constants.json` 里 —— 那是跨语言契约的存放处，而这个
/// 凭据只在壳与它自己 spawn 的壳之间流动（`spawn_daemon` 设、`cli_run_guard` 收），
/// 内核不读它。放进 shared 会让内核侧也多读一个与它无关的键（D9 的划分标准）。
/// 故定义为壳内常量，与 `mgmt.rs` 的 `MGMT_TOKEN_HEADER_CELL` 同一条理由。
pub fn spawn_token_env() -> &'static str {
    "DSH_RUN_GUARD_TOKEN"
}

/// 常量时间比较。与 `mgmt.rs` 的 `token_eq` 同一形态（不导入私有项，此处自持一份
/// 短实现：两个 &str 的长度都可能不同，先比长度会泄漏长度信息，故仍走定长缓冲）。
pub fn token_eq_generic(got: &str, want: &str) -> bool {
    let g = got.as_bytes();
    let w = want.as_bytes();
    if g.len() != w.len() {
        return false;
    }
    let mut acc: u8 = 0;
    for i in 0..g.len() {
        acc |= g[i] ^ w[i];
    }
    acc == 0
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
            crate::brand::proc_match_guard()
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
    let raw = crate::brand::proc_match_guard();
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

pub fn exec_guard(spec: &LaunchSpec) -> Result<(), String> {
    #[cfg(windows)]
    let mut cmd = {
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
        let mut c = if is_shim {
            let mut c = std::process::Command::new("cmd");
            c.arg("/C").arg(&spec.guard).arg("daemon");
            c
        } else {
            let mut c = std::process::Command::new(&spec.node);
            c.arg(&spec.guard).arg("daemon");
            c
        };
        c.creation_flags(0x0000_0008 | 0x0800_0000);
        c
    };
    #[cfg(not(windows))]
    let mut cmd = {
        let mut c = std::process::Command::new(&spec.node);
        c.arg(&spec.guard).arg("daemon");
        c
    };
    cmd.env("PATH", &spec.env_path)
        // 变量名走 brand::env_state_root()（shared-constants.json 的 env.stateRoot），
        // 与内核侧 state-root.js:12 读同一个键。字面量写这里是绕过跨语言单源：
        // 两侧名字一旦不一致，内核读不到状态根，全套状态文件静默漂到默认位置。
        .env(crate::brand::env_state_root(), &spec.state_root);
    guard_stdio(&mut cmd);
    let mut child = cmd.spawn().map_err(|e| format!("启动内核失败: {}", e))?;
    let st = child.wait().map_err(|e| format!("等待内核退出失败: {}", e))?;
    if st.success() { Ok(()) } else { Err(format!("内核退出码: {:?}", st.code())) }
}

pub trait Platform: Send + Sync {
    fn name(&self) -> &'static str;
    fn service(&self) -> &'static dyn service::ServiceControl;
    fn capabilities(&self) -> Capabilities;

        
    fn core_platform_tag(&self) -> Option<&'static str>;

    fn node_artifact(&self, version: &str) -> Option<NodeArtifact>;

        
    fn is_local_fixed_dir(&self, dir: &std::path::Path) -> bool;

    /// 把归档解开到 dest（目录）。
    ///
    /// 抽到 trait 是为了让运行时引擎复用既有平台解包能力，而不是在引擎里
    /// 重写一套平台分支 —— 否则新增运行时时平台差异会被复制第二遍。
    /// 返回解出后可执行文件所在目录。
    fn extract_archive(&self, archive: &std::path::Path, dest: &std::path::Path) -> Result<std::path::PathBuf, String>;

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
            std::env::var_os(crate::brand::state_root_linux_xdg_env()),
            &home_dir(),
        )
    }


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
/// 写 Windows 用户级环境变量。
///
/// 用系统自带的 reg.exe（HKCU\Environment），不用 FFI 直调注册表 API。
///
/// 此前这里手写 extern "system" 声明 RegOpenKeyExW/RegSetValueExW，其中两处错：
///   1. 子键串写成 "Environment\0" —— Rust 的 \0 是 U+0000 字符而不是 NUL 终止符，
///      拼出的键名里带一个空字符，注册表里根本没有该子键，于是返回 2 (FILE_NOT_FOUND)。
///      真机症状：打开 HKCU\Environment 失败: 2。
///   2. 句柄常量按指针语义构造。
/// 相比之下 reg.exe 是系统工具：键名与编码由它自己处理，也没有 setx 的 1024 字符截断。
pub fn set_windows_user_env(key: &str, value: &str) -> Result<(), String> {
    #[cfg(windows)]
    {
        let path = format!("HKCU\\Environment\\{}", key);
        let mut cmd = std::process::Command::new("reg.exe");
        cmd.arg("add").arg(&path).arg("/t").arg("REG_EXPAND_SZ")
            .arg("/f").arg("/d").arg(value);
        crate::bounded::prepare(&mut cmd);
        let out = crate::bounded::run(&mut cmd, std::time::Duration::from_secs(15))
            .map_err(|e| e.to_string())?;
        if !out.success {
            return Err(format!(
                "写入用户环境变量 {} 失败（exit={:?}）: {}",
                key,
                out.code,
                crate::bounded::exit_code_label(Some(out.code.unwrap_or(-1)))
            ));
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        Err("set_windows_user_env 只在 Windows 可用".to_string())
    }
}
/// Unix：把 bin 目录以 export PATH 追加到 shell profile。
///
/// 必须**追加**而非覆盖 —— 直接写 PATH= 会抹掉用户已有的全部条目。
/// 幂等：已存在则跳过，重复安装不会把 profile 撑大。
pub fn append_unix_path_export(bin_dir: &std::path::Path) -> Result<(), String> {
    #[cfg(not(windows))]
    {
        let home = crate::env::home();
        let line = format!("export PATH=\"{}:$PATH\"", bin_dir.display());
        for name in [".bashrc", ".zshrc", ".profile"] {
            let f = home.join(name);
            if let Ok(cur) = std::fs::read_to_string(&f) {
                if cur.lines().any(|l| l.contains(&line)) {
                    continue;
                }
            }
            use std::io::Write;
            let mut out = std::fs::OpenOptions::new().create(true).append(true).open(&f)
                .map_err(|e| format!("打开 {} 失败: {}", f.display(), e))?;
            writeln!(out, "\n# added by lobox runtime manager\n{}", line).map_err(|e| e.to_string())?;
        }
        Ok(())
    }
    #[cfg(windows)]
    {
        Err("append_unix_path_export 只在 Unix 可用".to_string())
    }
}