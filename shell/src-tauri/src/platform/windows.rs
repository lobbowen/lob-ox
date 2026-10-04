//! Windows 平台实现（计划任务 schtasks）。本文件是 Windows 的**全部**平台知识。

use std::path::{Path, PathBuf};
use std::process::Command;

use super::service::ServiceControl;
use super::{home_dir, Capabilities, LaunchSpec, Platform, SVC_NORMAL, SVC_QUICK};

pub const NAME: &str = "windows";
pub const GUARD_TASK: &str = crate::brand::WINDOWS_GUARD_TASK;
pub const WATCHDOG_TASK: &str = crate::brand::WINDOWS_WATCHDOG_TASK;

/// 「守卫活着吗」不得只看 TCP 端口存活；GUI 自愈的唯一所有者是守卫（内核 `domains/shell/watchdog`：进程实存 + 宽限 + 更新相位时效），看护任务只剩：守卫没就绪时把它拉起来 —— 见 `domain::cli::cli_watchdog`。
pub const WATCHDOG_ARGS: &[&str] = &["--watchdog"];

fn ps_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

/// 归档解包超时（15 分钟；下载已完成，余量给解包与慢盘）。
const INSTALL_CMD_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15 * 60);

fn fresh_dir(dir: &Path) -> Result<(), String> {
    let _ = std::fs::remove_dir_all(dir);
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())
}

/// 首选解包器：Windows 10 1803+ 内置的 bsdtar（`System32\tar.exe`，走宽字符路径 API）。PowerShell 的 `Expand-Archive` 对超过 260 字符的路径条目会静默丢弃且退出码为 0（Node 的 npm 依赖树必然超过）。返回 Err 只代表「这条路走不通」，由调用方决定是否回退。
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

/// 回退解包器：PowerShell 内置 `Expand-Archive`（更老的 Windows 上唯一无需安装的解法）。它可能产出**残缺树** —— 调用方必须过 `commit_user_node` 的完整性校验：宁可报「不含可用 npm」，也不报「环境已就绪」。
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
                // 用户级安装：官方对 x64/arm64 都提供 zip，解到 <状态根>/node，无需 UAC；arm64 用原生制品（MSI 路径提权后常读不到用户 profile 下的包，msiexec 1619）。
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
                // 不得硬编码 C:\Program Files：真实路径随系统盘符与系统语言变化（中文系统是本地化目录名），也可能装在 Program Files (x86)，故一律经环境变量推导。
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
        crate::env::node_install_root().join(self.node_exe_name())
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
                // 用户级解包（zip），零权限：MSI+UAC 路径提权后常读不到用户 profile 下的 .msi（msiexec 1619），且 canonicalize() 返回的 \\?\ 前缀 msiexec 不认；zip 解包两条问题都不存在。
        let root = crate::env::node_install_root();
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

impl Impl {
        /// 建立/更新守卫计划任务，返回成功所用的方式。用户态守卫不需要最高权限，故不请求 `/RL HIGHEST`：非提权进程带这一项必被拒。同名任务由更高权限持有时先 `/Delete` 再建一次；连删都拒绝，就把「谁持有它」说清并交回调用方换通道。
    fn create_guard_task(&self, action: &str) -> Result<&'static str, String> {
        // 触发器刻意用 MINUTE（与看护任务同一类），不用 ONLOGON：
        //   实测多台受限机器（组策略/非管理员）上 `/SC ONLOGON` 与 `/SC ONSTART` 直接 "Access is denied"，
        //   而 MINUTE / HOURLY / DAILY / WEEKLY / MONTHLY 都能建 —— 于是守卫定义被逼降级到 HKCU Run 键，
        //   而 Run 键不支持即时启动 ⇒ 每次启动都只能"直接拉起"，服务管理器路径形同虚设（用户观感：一直走兜底）。
        //   周期触发对守卫是正确的语义：看护本就每 5 分钟把守卫拉回（崩溃自愈），守卫任务与之同族即可。
        let build = || {
            let mut c = Command::new("schtasks");
            c.args([
                "/Create", "/TN", GUARD_TASK, "/SC", "MINUTE", "/MO", "5", "/F", "/TR", action,
            ]);
            c
        };
        let mut first = build();
        let r = crate::bounded::run(&mut first, SVC_NORMAL)?;
        if r.success {
            return Ok("普通权限");
        }
        let why = r.failure("schtasks /Create");
        if !is_access_denied(&why) {
            return Err(why);
        }
        let mut delcmd = Command::new("schtasks");
        delcmd.args(["/Delete", "/TN", GUARD_TASK, "/F"]);
        let del = crate::bounded::run(&mut delcmd, SVC_NORMAL)?;
        if !del.success {
            return Err(format!(
                "{}（同名任务由更高权限持有，删不掉也无法覆盖：{}）",
                why,
                del.stderr.trim()
            ));
        }
        let mut retry = build();
        let again = crate::bounded::run(&mut retry, SVC_NORMAL)?;
        if again.success {
            return Ok("普通权限，先删除了旧任务");
        }
        Err(again.failure("schtasks /Create"))
    }

    fn ensure_run_key(&self, action: &str) -> Result<(), String> {
        let mut cmd = Command::new("reg");
        cmd.args(["add", RUN_KEY, "/v", RUN_VALUE, "/t", "REG_SZ", "/d", action, "/f"]);
        let r = crate::bounded::run(&mut cmd, SVC_NORMAL)?;
        if r.success {
            return Ok(());
        }
        Err(r.failure("reg add 登录自启项"))
    }

        /// 壳拥有的 Windows 看护任务：计划任务直接指向稳定入口的无头模式。幂等：每次 ensure_defined 都 `/Create /F`（覆盖语义），故不会因守卫任务「已是最新」而被跳过。
    fn watchdog_status(&self, spec: &LaunchSpec) -> String {
        match self.ensure_watchdog(spec) {
            Ok(s) => format!("；{}", s),
            Err(e) => format!("；看护未建立（{}）", e),
        }
    }

    fn ensure_watchdog(&self, spec: &LaunchSpec) -> Result<String, String> {
        let stale = crate::env::supervisor_dir().join("watchdog.ps1");
        if stale.exists() {
            let _ = std::fs::remove_file(&stale);
        }
        let (shell, args) = (spec.shell.as_path(), WATCHDOG_ARGS);
        let tr = super::service_exec_line(shell, args);
        let r = crate::bounded::run(
            Command::new("schtasks").args([
                "/Create", "/TN", WATCHDOG_TASK, "/SC", "MINUTE", "/MO", "5", "/F", "/TR", &tr,
            ]),
            SVC_NORMAL,
        )?;
        if r.success {
            Ok(format!("看护任务 {} 已建立", WATCHDOG_TASK))
        } else {
            Err(r.failure("schtasks 建立看护任务"))
        }
    }

}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Channel {
    Task,
    RunKey,
}

impl Channel {
    fn tag(self) -> &'static str {
        match self {
            Channel::Task => "task",
            Channel::RunKey => "runkey",
        }
    }

    fn parse(s: &str) -> Option<Channel> {
        match s {
            "task" => Some(Channel::Task),
            "runkey" => Some(Channel::RunKey),
            _ => None,
        }
    }
}

fn read_action_record(path: &Path) -> (Option<Channel>, String) {
    let raw = match std::fs::read_to_string(path) {
        Ok(s) => s,
        Err(_) => return (None, String::new()),
    };
    let raw = raw.trim_end_matches(|c| c == '\r' || c == '\n');
    match raw.split_once('\t') {
        Some((chan, action)) => (Channel::parse(chan), action.to_string()),
        None => (Some(Channel::Task), raw.to_string()),
    }
}

fn write_action_record(path: &Path, channel: Channel, action: &str) -> Result<(), String> {
    std::fs::write(path, format!("{}\t{}", channel.tag(), action))
        .map_err(|e| format!("写入动作记录失败: {}", e))
}

/// 权限类失败：只有这一类值得换通道，参数/策略类失败重试同一条命令不会变好。中英 Windows 的同一事实（`schtasks` 的 stderr 已由 bounded 按控制台码页解码）。
fn is_access_denied(text: &str) -> bool {
    let t = text.to_lowercase();
    text.contains("拒绝访问") || t.contains("access is denied") || t.contains("access denied")
}

const RUN_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
// Run 键里的值名（登录自启的兜底通道，schtasks 不可用时用）：与计划任务名同属「我们的服务标识」，
// 故取自跨语言单源（User 可见于任务管理器「启动」页）。
const RUN_VALUE: &str = crate::brand::WINDOWS_RUN_VALUE;

impl ServiceControl for Impl {
    fn kind(&self) -> &'static str {
        "schtasks"
    }

    fn definition_path(&self) -> PathBuf {
                // 计划任务不是文件；返回标识串供日志/诊断。正因如此，**不能**用 `definition_path().is_file()` 判断「定义是否存在」（恒 false，会让 --service-plan 自检误报）—— 见下面的 is_defined 覆写。
        PathBuf::from(format!("schtasks://{}", GUARD_TASK))
    }

    fn is_defined(&self) -> bool {
        matches!(
            crate::bounded::run(
                Command::new("schtasks").args(["/Query", "/TN", GUARD_TASK]),
                SVC_QUICK,
            ),
            Ok(o) if o.success
        )
    }

        /// 建立守卫定义（幂等，且动作或通道过时时自愈）。计划任务本身回读不到动作串，故本地留一份动作记录比对；若以「Query 成功即返回」当完成，修复永远到不了已装用户。
    fn ensure_defined(&self, spec: &LaunchSpec) -> Result<String, String> {
        let task_exists = self.is_defined();
        let (shell, args) = spec.service_command();
        let action = super::service_exec_line(shell, args);
        let record = crate::env::supervisor_dir().join("guard-task.action");
        if let Some(dir) = record.parent() {
            std::fs::create_dir_all(dir).map_err(|e| format!("创建状态目录失败: {}", e))?;
        }
        let (channel, recorded) = read_action_record(&record);
        if task_exists && channel == Some(Channel::Task) && recorded == action {
            let wd = self.watchdog_status(spec);
            return Ok(format!("已存在且为最新 计划任务 {}{}", GUARD_TASK, wd));
        }
        let verb = if task_exists { "已更新" } else { "已建立" };
        match self.create_guard_task(&action) {
            Ok(how) => {
                write_action_record(&record, Channel::Task, &action)?;
                Ok(format!(
                    "{} 计划任务 {}（{}）-> {}{}",
                    verb, GUARD_TASK, how, action, self.watchdog_status(spec)
                ))
            }
            Err(e) => match self.ensure_run_key(&action) {
                Ok(()) => {
                    write_action_record(&record, Channel::RunKey, &action)?;
                    Ok(format!(
                        "计划任务不可用（{}）；已改用登录自启项 {} -> {}{}",
                        e, RUN_VALUE, action, self.watchdog_status(spec)
                    ))
                }
                Err(e2) => Err(format!("计划任务与登录自启项都建立不了：{}；{}", e, e2)),
            },
        }
    }

    fn start(&self) -> Result<(), String> {
                // 定义写在哪个通道，就向哪个通道请求启动：对只存在于 Run 键的守卫发 `/Run`，得到的是「找不到任务」，那会把兜底通道伪装成服务管理器故障。
        let (channel, _) = read_action_record(&crate::env::supervisor_dir().join("guard-task.action"));
        if channel == Some(Channel::RunKey) {
            return Err("定义通道是登录自启项（HKCU Run），它不支持即时启动".to_string());
        }
        crate::bounded::run_checked(
            Command::new("schtasks").args(["/Run", "/TN", GUARD_TASK]),
            SVC_NORMAL,
            "schtasks /Run",
        )
        .map(|_| ())
    }

    fn stop(&self) -> Result<(), String> {
                // 看护任务必须 /Delete 整条计划：/End 只结束本次实例，/SC MINUTE /MO 5 的计划仍会在 5 分钟内再次触发把守卫拉回来。删除后下次 ensure_defined 幂等重建。全部有界：退出流程也要能在服务管理器无响应时走完。
        crate::bounded::run_lossy(
            Command::new("schtasks").args(["/Delete", "/TN", WATCHDOG_TASK, "/F"]),
            SVC_NORMAL,
        );
        crate::bounded::run_lossy(
            Command::new("schtasks").args(["/End", "/TN", GUARD_TASK]),
            SVC_NORMAL,
        );
                // 守卫镜像名是 node.exe（不是 lobox.exe），按镜像名 taskkill 杀不到它；按命令行含守卫模式精确匹配再杀，绝不误杀 DSH 自身的 node。
        // 匹配串取自跨语言单源（brand.rs::PROC_MATCH_GUARD = "*lobox*"，与 brand.js 同名同值）：此处再写一份字面量 = 改名漏一处 ⇒ 停守卫变成空操作。
        // 为什么不会误杀 DSH 的 node：过滤器先按镜像名钉死 node.exe，再要求命令行含产品名；DSH 侧入口是 `dsh`（B 类外部名，永不含 lobox）。
        let ps = format!(
            "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object {{ $_.CommandLine -like '{}' }} | ForEach-Object {{ Stop-Process -Id $_.ProcessId -Force }}",
            crate::brand::PROC_MATCH_GUARD
        );
        crate::bounded::run_lossy(
            Command::new("powershell")
                .args([
                    "-NoProfile",
                    "-NonInteractive",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-Command",
                ])
                .arg(ps.as_str()),
            SVC_NORMAL,
        );
        Ok(())
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
        // DRIVE_FIXED = 3；其余（REMOTE=4 / NO_ROOT_DIR=1 / UNKNOWN=0）一律跳过
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
        assert!(
            node.starts_with(&home),
            "安装必须落在 DSH_SUPERVISOR_HOME 下，实际：{}",
            node.display()
        );
        let _ = std::fs::remove_dir_all(&home);
    }
}

#[cfg(test)]
mod definition_tests {

    use super::{is_access_denied, read_action_record, write_action_record, Channel};

    fn tmp_record(tag: &str) -> std::path::PathBuf {
        let p = std::env::temp_dir().join(format!("dsh-rec-{}-{}.txt", tag, std::process::id()));
        let _ = std::fs::remove_file(&p);
        p
    }

    #[test]
    fn channel_record_roundtrips_and_defaults_to_task_for_legacy() {
        let p = tmp_record("chan");
        assert_eq!(read_action_record(&p).0, None, "文件不存在时必须报「无通道」而非猜一个");
        write_action_record(&p, Channel::RunKey, r#""C:\a b\dsh.exe" --run-guard"#).unwrap();
        let (c, a) = read_action_record(&p);
        assert_eq!(c, Some(Channel::RunKey), "通道写进记录却没读回来 -> 下次比对会走错通道");
        assert_eq!(a, r#""C:\a b\dsh.exe" --run-guard"#, "动作串被通道前缀污染");
        std::fs::write(&p, r#""C:\x\dsh.exe" --run-guard"#).unwrap();
        assert_eq!(read_action_record(&p).0, Some(Channel::Task), "旧记录未按计划任务解读");
        std::fs::write(&p, "task\t\"C:\\x\\dsh.exe\"\r\n").unwrap();
        let (c, a) = read_action_record(&p);
        assert_eq!((c, a.as_str()), (Some(Channel::Task), "\"C:\\x\\dsh.exe\""));
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn only_permission_shaped_failures_change_channel() {
        for denied in ["错误: 拒绝访问。\r\n", "ERROR: Access is denied.\n", "Access denied"] {
            assert!(is_access_denied(denied), "权限类失败被漏判: {}", denied);
        }
        for other in [
            "ERROR: The system cannot find the file specified.",
            "错误: 无效的参数。",
            "schtasks /Create 失败（超时被 kill）",
        ] {
            assert!(!is_access_denied(other), "非权限类失败被判成权限类 -> 白白换一次通道: {}", other);
        }
    }
}
