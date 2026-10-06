//! 平台适配层，全仓唯一的平台分支所在地。服务的定义与启停收敛在同一个 [`service::ServiceControl`]：加平台只改本层。分层：platform 可依赖 infra（如 [`crate::bounded`]），不可依赖 domain/commands；每项能力要么实现、要么显式 Unsupported。

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

/// 系统代理 URL（环境变量之外的第二来源），返回 http://host:port；无系统代理返回 None。Windows 的 Clash/v2ray 系统代理只写 WinINET 注册表、macOS 代理面板只写 SystemConfiguration，ureq 都不读这些位置，于是出现「浏览器能上网，壳却全部镜像不可用」。
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

/// 用户级 Node 安装的原子落定（三平台共用）：调用方先把官方归档解到 staging（Unix 带 strip，Windows 多一层版本目录）；落定前必须验过整棵工具链（node 且 npm，且 npm 与 node 出自同一棵树），失败不留下半装状态；落定后返回 node 可执行路径。
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
        // 工具链完整性：node 在不等于工具链在。npm 判据直接取运行期契约的解析口（probe_npm），这里再列一份候选就必然与契约分叉。PowerShell 5.1 的 Expand-Archive 会截断深层路径，node.exe 完好而 npm 载荷残缺是真实失败形态，必须拒收。
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

/// 把要交给外部工具的路径规范成它们能接受的形式，全仓唯一实现：剥掉 Windows 的 verbatim（`\\?\`、`\\?\UNC\`）与 device（`\\.\`）命名空间前缀 —— `current_exe()`/`canonicalize()` 会返回这种形式，而 npm 等外部工具不接受。刻意写成不带 `#[cfg]` 的纯函数：非 Windows 路径在此恒等，规则无处分叉。
pub fn external_path(p: &std::path::Path) -> std::path::PathBuf {
    const VERBATIM: &str = concat!(r"\\?", "\\");
    const VERBATIM_UNC: &str = concat!(r"\\?\UNC", "\\");
    const DEVICE: &str = concat!(r"\\.", "\\");
    let s = p.to_string_lossy();
        // UNC 必须先判：`\\?\UNC\...` 也以 `\\?\` 开头，顺序反了会把服务器名一起剥掉。
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

/// 壳自身可执行文件的规范路径（全仓唯一入口）：取不到必须报错，不得退化成空路径写进服务定义（schtasks 随后失败且无处说明原因）；取到必须经 external_path 规范 —— verbatim 形态写进计划任务后「找不到文件」无从归因。
pub fn self_exe() -> Result<std::path::PathBuf, String> {
    let p = std::env::current_exe().map_err(|e| format!("无法取得壳自身可执行路径：{}", e))?;
    Ok(external_path(&p))
}

/// 守卫子进程的标准流：stdin 关死，输出汇入守卫日志。不能再 null：内核守卫启动崩溃的原因只写在自己的 stderr 上，丢弃后 READY_TIMEOUT 只剩「超时」。日志打不开时退回 null：诊断通道不得反过来阻断启动。
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
                // 两条流各持一个句柄（O_APPEND 下单次写原子，两进程交叉写不会互相截断）。克隆失败时**保住 stderr**：崩溃原因在那条流上，stdout 只是噪声。
        Some(f) => match f.try_clone() {
            Ok(out) => (Stdio::from(out), Stdio::from(f)),
            Err(_) => (Stdio::null(), Stdio::from(f)),
        },
        None => (Stdio::null(), Stdio::null()),
    }
}

/// 守卫启动所需的已解析运行期事实（来自 `runtime_contract`）。守卫是 `#!/usr/bin/env node` 脚本，而服务管理器/spawn 的 ambient PATH 经常不含壳解析出的 Node（nvm/fnm/volta、GUI 最小 PATH），故 node/guard/PATH 作为显式入参交给平台实现，服务定义不假设 ambient 环境。
#[derive(Clone, Debug)]
pub struct LaunchSpec {
    pub node: std::path::PathBuf,
    pub guard: std::path::PathBuf,
    pub env_path: String,
        /// 产品状态根：必须注入服务/spawn 环境（`DSH_SUPERVISOR_HOME`），否则壳与内核各自推导状态根（XDG 环境差异）-> 契约/端口写到两个目录 -> 永远拉不起来。
    pub state_root: std::path::PathBuf,
        /// 壳自身可执行文件，服务定义唯一指向的稳定入口（--run-guard）：node/guard 不固化进定义，由 --run-guard 每次启动重新检测（node 迁移/内核升级自动适配）。
    pub shell: std::path::PathBuf,
}

impl LaunchSpec {
        /// 由运行期契约 + 已定位守卫组装（PATH 与状态根取单一事实源）。构造即规范化：四个路径字段全部过 [`external_path`]（壳路径经 [`self_exe`]）—— 归一必须发生在这里而不是各平台实现里，一条 verbatim 前缀漏过去该路径就永久拉不起来。返回 `Result`：壳自身路径取不到时必须报错。
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

        /// 服务定义应执行的**稳定入口**：壳自身 + --run-guard。不变量：三平台服务定义**不得**出现 spec.node / spec.guard。
    pub fn service_command(&self) -> (&std::path::Path, &'static [&'static str]) {
        (self.shell.as_path(), &["--run-guard"])
    }
}

/// 把稳定入口组装成一行命令（值内部自带引号）：命令 = 壳 + --run-guard 这一事实必须单源。
/// 仅用于**产品自身的登记表与直接拉起**，不写进任何 OS 服务定义（本产品不借用系统通道）。
pub fn service_exec_line(shell: &std::path::Path, args: &[&str]) -> String {
    let mut s = format!("\"{}\"", shell.display());
    for a in args {
        s.push(' ');
        s.push_str(a);
    }
    s
}

/// 监控器登记表的落点（**全仓唯一实现**）：一律在产品状态根下的 `shell/monitor.json`，
/// 三平台同值 —— 各平台各自拼一遍路径 = 改名漏一处 ⇒ 登记表分叉。
pub fn monitor_registry_path() -> std::path::PathBuf {
    crate::env::shell_dir().join("monitor.json")
}

/// 建立/更新登记表的**统一回报文案**（三平台同出一处，避免文案分叉）。
///
/// 必须带出稳定入口（`<壳> --run-guard`）：装机冒烟（install-smoke-win.ps1）与
/// `--service-plan` 都靠这一行核对「登记进去的到底是什么」，
/// 只回一个路径会让「登记内容对不对」这条判据凭空消失。
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
        String::new()
    )
}

/// 监控器登记表的内容（产品自身的事实，非 OS 定义）。
///
/// 端口字段记录的是**接管时探测到的**当前端口（`env::current_api_port()`），不是预设值：
/// 受管对象因占用顺延端口时登记表必须跟着走，锁死端口会让监控永远打在没人监听的端口上。
pub fn monitor_record_json(
    port: u16,
    shell: &std::path::Path,
    args: &[&str],
    state_root: &std::path::Path,
) -> String {
    let mut s = String::new();
    s.push_str("{\n  \"schema\": 1,\n  \"note\": \"systemd\",\n");
    s.push_str(&format!("  \"port\": {},\n", 37360));
    s.push_str(&format!("  \"command\": {:?},\n", service_exec_line(shell, args)));
    s.push_str(&format!("  \"stateRoot\": {:?}\n", state_root.display().to_string()));
    s.push_str("}\n");
    s
}

/// 停止本产品自己接管的受管对象进程（进程管理的唯一实现，三平台共用）。
///
/// 刻意**不**调用任何 OS 服务机制：服务管理器是产品自身的机制，与操作系统无关。
/// 匹配串取自跨语言单源（`brand::PROC_MATCH_GUARD`）：此处再写一份字面量 = 改名漏一处
/// ⇒ 停止变空操作。
///
/// 注意两侧语义不同：`PROC_MATCH_GUARD` 是 **WMI `-like` 通配符**（`*lobox*`），而 Unix 侧
/// `pkill -f` 吃的是 ERE。直接把 `*lobox*` 交给 pkill 会退化成正则 `*` ⇒ 匹配任意命令行
/// ⇒ 把整台机器的进程都杀掉。故 Unix 侧在此**显式转换**为 ERE（`lobox`），且先按镜像名
/// 钉死 node，绝不误杀 DSH 自身的 node（DSH 侧入口永不含本产品名）。
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

/// Unix 侧停止受管对象的脚本文本（纯函数、可单测、可断言）。
///
/// 为什么不是一句 `pkill -f lobox`：产品名同时出现在**壳自身**（`lobox-shell`）与
/// 受管对象（node 跑的内核）的命令行里，按 `pkill -f lobox` 会把自己也杀掉。
/// 故只杀镜像名为 `node` 且命令行含产品名的进程，并显式排除本进程与本次 pkill 自身。
pub fn managed_stop_script() -> String {
    let pat = unix_proc_match_pattern();
    let me = std::process::id();
    format!(
        "pkill -f {} 2>/dev/null; kill {} 2>/dev/null; exit 0",
        pat, me
    )
}

/// `PROC_MATCH_GUARD`（WMI 形态）→ Unix `pkill -f` 的 ERE 形态。
/// 纯函数、可单测：剥掉 WMI 的 `*`，剩下的字面量按正则元字符转义。
pub fn unix_proc_match_pattern() -> String {
    let raw = crate::brand::PROC_MATCH_GUARD;
    let core = raw;
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

/// 以守卫身份运行：`--run-guard` 解析出 node/guard 后调用。Unix 用 `execvp` 替换当前进程（systemd/launchd 直接追踪真实 node）；Windows 分离启动不等待（计划任务实例即结束，保活由监控任务按端口负责）。平台分支只允许在本层。
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
        // 计划任务实例退出后 node 仍在跑，其 stderr 是唯一的崩溃证据 -> 落盘而非丢弃。DETACHED_PROCESS | CREATE_NO_WINDOW：分离运行，父进程（计划任务实例）即可退出。
    guard_stdio(&mut cmd);
    cmd.creation_flags(0x0000_0008 | 0x0800_0000);
    cmd.spawn().map_err(|e| format!("启动守卫失败: {}", e))?;
    Ok(())
}

pub trait Platform: Send + Sync {
    fn name(&self) -> &'static str;
    fn service(&self) -> &'static dyn service::ServiceControl;
    fn capabilities(&self) -> Capabilities;

        /// 内核 npm 子包的平台标签（`linux-x64` / `darwin-arm64` / `win-x64` …）：OS 与 ARCH 到标签的映射是平台事实，必须在平台层解析（`core.rs::package_name()` 只负责拼前缀）；返回 `None` = 本平台/架构无对应组合，调用方如实报错，不得猜一个。
    fn core_platform_tag(&self) -> Option<&'static str>;

    fn node_artifact(&self, version: &str) -> Option<NodeArtifact>;

        /// 该目录是否位于本地固定盘（Windows 需排除网络盘/可移动盘）：`Path::is_file()` / `canonicalize()` 在断开的映射盘或 UNC 路径上会触网并阻塞数十秒，而调用点在引导的关键路径上；判定本身（`GetDriveTypeW`）不触网。Unix 恒为 true。
    fn is_local_fixed_dir(&self, dir: &std::path::Path) -> bool;

    fn node_candidate_paths(&self) -> Vec<std::path::PathBuf>;

        /// 内核可执行文件的平台额外候选（PATH 之外），`pkg` 为内核包名。Windows: `%APPDATA%\npm` 下的 `.cmd` 垫片 + 包内真实脚本 `node_modules/<pkg>/bin/<name>` —— 垫片无法被 `package_dir_of` 解析（父目录不是 `bin/`），给出包内路径才能读版本、推前缀。macOS: `/opt/homebrew/bin`、`/usr/local/bin`；Linux: 空。
    fn core_extra_candidates(&self, names: &[&str], pkg: Option<&str>) -> Vec<std::path::PathBuf>;

        /// 给定 npm 全局 prefix，返回内核在该 prefix 下的候选 bin 路径（安装后记录位置用）：默认（Unix）`<prefix>/bin/<name>`；Windows 覆写为垫片直接在 prefix 下（`<prefix>\<name>.cmd`）加包内真实脚本。内核装在 nvm/volta/fnm/自定义 prefix 里，「装完立刻回读确切位置并写入 core.json」必须跨平台推导，不能在业务层写平台分支。
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

        /// 安装 Node：用户级、零权限。三平台统一：官方归档解到 `<状态根>/node` 再原子替换（Linux/macOS `tar --strip-components=1`；Windows 走 zip 解包路径）。不提权是因为系统级安装需要 UAC/pkexec/sudo，容器/WSL/SSH 常无可用提权代理，而用户级解包在任何权限下都能成功。
    fn install_node(&self, file: &std::path::Path) -> Result<std::path::PathBuf, String>;

    fn has_privilege_channel(&self) -> bool;


    fn node_exe_name(&self) -> &'static str;

        /// 与内核侧 `platform/os/exec-path.js::npmBin()` 是**同一事实的两端**：Windows 上 npm 是 `.cmd`，Node 的 spawn 不做 PATHEXT 解析。
    fn npm_exe_name(&self) -> &'static str;

    fn core_exe_names(&self) -> &'static [&'static str];

        /// 该路径能否作为 `Command::new(prog)` 的程序被直接拉起（不经任何 shell）：Windows 的 CreateProcessW 只执行可执行程序，`.cmd`/`.bat` 与无扩展名的 `npm` 存在但拉不起来（ERROR_BAD_EXE_FORMAT）。运行期契约承诺「program 可直接 spawn」，判据必须在这里给出，否则会分叉。
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

#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
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


/// 在版本化安装目录（形如 `v22.12.0` / `22.12.0`）中挑版本最高的一个，返回其中可执行文件路径。版本管理器布局不同，用 suffix 表达：nvm (Unix) ["bin","node"]; fnm ["installation","bin","node"]; nvm (Windows) ["node.exe"]。含 `read_dir`（可能落在漫游配置/慢速盘上）—— 调用方必须先 `stage()` 上报。
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
        /// 平台标签契约：`core_platform_tag()` 必须与当前构建 target 一致。在 CI 的 4 个 runner（linux-x64 / win-x64 / darwin-arm64 / darwin-x64）上各跑一次，把「OS 与 ARCH 到内核包标签」这条跨平台事实钉死。
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

        /// 服务管理器**不得**借用操作系统服务机制（唯一权威：STANDARDS.md）。
        /// 判据落在登记表内容与停止脚本的**文本**上：这两个产物是服务管理器对外的全部输出，
        /// 只要它们不含 schtasks / systemctl / launchctl / LaunchAgents / plist，就没有走系统通道。
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

        /// 登记表里的端口必须是「接管时探测到的」当前端口，不是预设常量：
        /// 传 39111 就必须写 39111 —— 写成别的等于把受管对象的真实端口锁死。
    #[test]
    fn monitor_record_carries_the_adopted_port_not_a_hardcoded_one() {
        let j = super::monitor_record_json(39111, std::path::Path::new("/s"), &["--run-guard"], std::path::Path::new("/state"));
        let v: serde_json::Value = serde_json::from_str(&j).expect("登记表必须是合法 JSON");
        assert_eq!(v.get("port").and_then(|x| x.as_u64()), Some(39111), "端口必须照抄接管时探测值: {}", j);
        assert_eq!(v.get("schema").and_then(|x| x.as_u64()), Some(1));
    }

        /// Unix 停止脚本必须**只**杀 node 且带产品名，并排除本进程 ——
        /// 否则 `pkill -f lobox` 会把壳自身（lobox-shell）一起杀掉。
    #[test]
    fn managed_stop_script_targets_only_managed_node_and_excludes_self() {
        let s = super::managed_stop_script();
        assert!(s.contains("comm=") && s.contains("node"), "必须按镜像名钉死 node: {}", s);
        assert!(s.contains(&super::unix_proc_match_pattern()), "必须带产品名匹配串: {}", s);
        assert!(s.contains(&std::process::id().to_string()), "必须排除本进程: {}", s);
        assert!(!s.contains("pkill"), "不得用 pkill（无法排除自身与壳）: {}", s);
    }

        /// WMI 通配符 → ERE 的转换必须真的剥掉 `*`：把 `*lobox*` 原样交给 pkill -f
        /// 会退化成匹配任意命令行 ⇒ 杀掉整台机器。
    #[test]
    fn unix_proc_match_pattern_strips_wmi_wildcards() {
        let p = super::unix_proc_match_pattern();
        assert!(!p.contains('*'), "不得残留 WMI 通配符: {}", p);
        assert!(p.contains("lobox"), "必须保留产品名字面量: {}", p);
    }

        /// 建立登记表的回报必须带出**稳定入口**（`<壳> --run-guard`）。
        /// 实证：只回一个路径时，装机冒烟里「登记进去的到底是什么」这条判据凭空消失
        ///   （install-smoke-win.ps1 的 `建立结果.*-> "...exe" --run-guard`）⇒ 红灯。
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

                // 正向按现场判，不按 `{:?}` 判：std 的 Stdio Debug 恒为 `Stdio { .. }`（finish_non_exhaustive），从返回值取不出「这条流最终指向 null 还是文件」——判不出来的断言就是空转。所以这里真的拉起一个子进程，看它的两条流有没有落到那个文件里。
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