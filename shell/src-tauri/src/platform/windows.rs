//! Windows 平台实现（计划任务 schtasks）。
//!
//! 本文件是 Windows 的**全部**平台知识（门禁 G1）。

use std::path::{Path, PathBuf};
use std::process::Command;

use super::service::ServiceControl;
use super::{home_dir, Capabilities, LaunchSpec, Platform, SVC_NORMAL, SVC_QUICK};

pub const NAME: &str = "windows";
/// 计划任务名（**定义由本文件建立**；内核不再管理，见 D6）。
pub const GUARD_TASK: &str = "DSH-Supervisor";
/// 崩溃自拉的保活任务（**由壳建立**；停止守卫时须先停它）。
/// 所有者 = 壳（KERNEL-DAEMON-CONTRACT D6）。
pub const WATCHDOG_TASK: &str = "DSH-Supervisor-Watchdog";

/// 看护任务的调用参数：只是稳定入口的一个无头模式（--watchdog），不再内嵌脚本。
/// 「守卫活着吗」只看 TCP 端口存活（旧内嵌 PowerShell 用 `Test-NetConnection` 判活），
/// GUI 自愈的唯一所有者是守卫（内核 `domains/shell/watchdog`：进程实存 + 宽限 + 更新相位时效），
/// 看护任务只剩：守卫没就绪时把它拉起来 —— 见 `domain::cli::cli_watchdog`。
pub const WATCHDOG_ARGS: &[&str] = &["--watchdog"];

/// PowerShell 单引号字符串（内部单引号翻倍；反斜杠为字面量，无需转义）。
fn ps_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

/// 归档解包超时（15 分钟；下载已完成，余量给解包与慢盘）。
const INSTALL_CMD_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15 * 60);

/// 清空并重建目标目录（解包器各自负责给出干净的目标，避免上一次的部分产物混进本次结果）。
fn fresh_dir(dir: &Path) -> Result<(), String> {
    let _ = std::fs::remove_dir_all(dir);
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())
}

/// 首选解包器：Windows 10 1803+ 内置的 bsdtar（`System32\tar.exe`，走宽字符路径 API）。
/// PowerShell 的 `Expand-Archive` 对超过 260 字符的路径条目会静默丢弃且退出码为 0
///   （Node 的 npm 依赖树必然超过）。返回 Err 只代表「这条路走不通」，由调用方决定是否回退。
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

/// 回退解包器：PowerShell 内置 `Expand-Archive`（更老的 Windows 上唯一无需安装的解法）。
///
/// 它可能产出**残缺树** —— 调用方必须过 `commit_user_node` 的完整性校验，
/// 该校验就是为这条路兜底的：宁可报「不含可用 npm」，也不报「环境已就绪」。
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
            native_service: true, // 计划任务
            privilege_channel: true, // 仅壳自更新（替换安装包）用；Node 安装已改为用户级、零权限
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
        // 用户级安装：官方对 x64/arm64 都提供 zip，解到 <状态根>/node，无需 UAC；
        //   arm64 用原生制品（MSI 路径提权后常读不到用户 profile 下的包，msiexec 1619）。
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
        // 不得硬编码 C:\Program Files：真实路径随系统盘符与系统语言变化（中文系统是本地化目录名），
        //   也可能装在 Program Files (x86)，故一律经环境变量推导。
        let exe = "node.exe";
        // 用户级安装（<状态根>/node）**最先**：壳自己装的，优先于系统其它 Node。
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
        // nvm-windows 有三种布局：LOCALAPPDATA\nvm、APPDATA\nvm、%NVM_HOME%
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
        // 用户级安装落点（零权限）；不再指向 %ProgramFiles%\nodejs（那需要管理员）。
        crate::env::node_install_root().join(self.node_exe_name())
    }

    fn is_usable_executable(&self, cand: &Path) -> bool {
        // 过滤两类伪可执行：\WindowsApps\ 下的应用执行别名存根（执行它会挂起或唤起 Store），
        //   以及 0 字节文件。
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
        // 用户级解包（zip），零权限：MSI+UAC 路径提权后常读不到用户 profile 下的 .msi（msiexec 1619），
        //   且 canonicalize() 返回的 \\?\ 前缀 msiexec 不认；zip 解包两条问题都不存在。
        let root = crate::env::node_install_root();
        let staging = root.with_file_name("node.extract");
        // 解包器必须长路径安全：npm 依赖树深过 260 字符，Expand-Archive 静默截断且退出码仍为 0。
        //   每条解包路都以 commit_user_node 的工具链校验为准，校验不过就换下一条；
        //   信任单一退出码会放行残缺树（tar 可能不存在 / Expand-Archive 会截断，失败形态不同）。
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
            // npm 生成的 .cmd 垫片（在 npm 根目录下）
            v.push(npm_root.join(name));
        }
        // 真实包内脚本：.cmd 垫片无法被 package_dir_of 解析（父目录不是 bin/），
        // 且执行它取版本在部分环境下会失败。直接给出包内真实路径优先命中，
        // 既能正确读 package.json 取版本，也能让 global_prefix_for 正常推导前缀。
        if let Some(p) = pkg {
            v.push(
                npm_root
                    .join("node_modules")
                    .join(p)
                    .join("bin")
                    .join("dsh-supervisor"),
            );
        }
        v
    }

    /// Windows：npm 全局垫片直接在 prefix 下（`<name>.cmd`），真实脚本在
    ///   `<prefix>\node_modules\<pkg>\bin\<name>`（后者可被 package_dir_of 正确解析版本）。
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

    /// Windows 状态根惯例：%LOCALAPPDATA%\dsh-supervisor。
    fn state_root_default(&self) -> PathBuf {
        let base = std::env::var("LOCALAPPDATA")
            .ok()
            .filter(|s| !s.trim().is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| home_dir().join("AppData").join("Local"));
        base.join("dsh-supervisor")
    }

    fn is_local_fixed_dir(&self, dir: &Path) -> bool {
        use std::os::windows::ffi::OsStrExt;
        // 先做本地固定盘判定（不触网），再访问文件系统；按盘符缓存，每盘只查一次。
        let w: Vec<u16> = dir.as_os_str().encode_wide().collect();
        // UNC（以两个反斜杠开头，ASCII 92）-> 跳过（纯字面判定，不触网）
        if w.len() >= 2 && w[0] == 92 && w[1] == 92 {
            return false;
        }
        // 无盘符（相对路径等）-> 保守放行
        if w.len() < 2 || w[1] != 58 {
            return true;
        }
        drive_is_fixed(w[0])
    }

    fn has_privilege_channel(&self) -> bool {
        // Windows 恒有 UAC 提权通道（**仅壳自更新用**；Node 安装已用户级、零权限）。
        true
    }

    // 可执行文件名的平台差异（P2/G1：原为平台层之外的 cfg!() 宏）
    fn node_exe_name(&self) -> &'static str { "node.exe" }
    /// Windows 上 npm 是 `.cmd`；Node 的 spawn/execFileSync **不做 PATHEXT 解析** ——
    /// 与内核侧 `platform/os/exec-path.js::npmBin()` 同一事实（P1-C）。
    fn npm_exe_name(&self) -> &'static str { "npm.cmd" }
    /// Windows 内核候选：`.cmd` 垫片必须在内 —— PATH 解析只认扩展名形态。
    fn core_exe_names(&self) -> &'static [&'static str] {
        &["dsh-supervisor.exe", "dsh-supervisor.cmd", "dsh-supervisor"]
    }

    /// 只有 PE 可执行程序能被 CreateProcessW 直接拉起：
    ///   `.cmd`/`.bat` 是 cmd.exe 的脚本、无扩展名的 `npm` 是 POSIX sh 脚本，
    ///   都「文件存在而拉不起来」（ERROR_BAD_EXE_FORMAT）。
    /// 因此 Windows 上 npm 一律经 node.exe + npm-cli.js 调用（见 runtime_contract::probe_npm）。
    fn is_directly_spawnable(&self, prog: &Path) -> bool {
        prog.extension()
            .map(|e| e.eq_ignore_ascii_case("exe"))
            .unwrap_or(false)
    }
}

/// Windows 的私有辅助（**不属于** ServiceControl 契约：放进 trait impl 会触发 E0407，
/// 由 ensure_defined 调用）：守卫任务的建任务/免提权自启两个通道，与壳拥有的看护任务。
impl Impl {
    /// 建立/更新守卫计划任务，返回成功所用的方式。用户态守卫不需要最高权限，故不再请求
    ///   `/RL HIGHEST`：非提权进程带这一项必被拒，而「先试必失败的一条再试同一条的另一形态」
    ///   只是把同一句拒绝访问打印两遍。同名任务由更高权限持有时先 `/Delete` 再建一次；
    ///   连删都拒绝，就把「谁持有它」说清并交回调用方换通道。
    fn create_guard_task(&self, action: &str) -> Result<&'static str, String> {
        let build = || {
            let mut c = Command::new("schtasks");
            c.args(["/Create", "/TN", GUARD_TASK, "/SC", "ONLOGON", "/F", "/TR", action]);
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

    /// 免提权的每用户自启：把稳定入口写进 HKCU 的 Run 键（登录时启动，语义同 ONLOGON 任务）。
    fn ensure_run_key(&self, action: &str) -> Result<(), String> {
        let mut cmd = Command::new("reg");
        cmd.args(["add", RUN_KEY, "/v", RUN_VALUE, "/t", "REG_SZ", "/d", action, "/f"]);
        let r = crate::bounded::run(&mut cmd, SVC_NORMAL)?;
        if r.success {
            return Ok(());
        }
        Err(r.failure("reg add 登录自启项"))
    }

    /// 壳拥有的 Windows 看护任务（D6/H5）：计划任务直接指向稳定入口的无头模式。
    /// 幂等：每次 ensure_defined 都 `/Create /F`（覆盖语义），
    ///   故不会因守卫任务「已是最新」而被跳过；升级后旧版本留下的 `watchdog.ps1` 就地删除。
    fn watchdog_status(&self, spec: &LaunchSpec) -> String {
        match self.ensure_watchdog(spec) {
            Ok(s) => format!("；{}", s),
            Err(e) => format!("；看护未建立（{}）", e),
        }
    }

    fn ensure_watchdog(&self, spec: &LaunchSpec) -> Result<String, String> {
        // 脚本形态已废除（见 WATCHDOG_ARGS 注释）；清掉历史文件，避免留下无人维护的第二实现。
        // 本仓的写入路径自 v1.2.2 起已移除，故本段对跑过它的装机是一次性的：清完即为 no-op。
        // 退役期限：v1.3（删除前置 = 活跃装机最低版本 >= 1.2.2；K-13 钉着 remove_file 必须在）。
        let stale = crate::env::supervisor_dir().join("watchdog.ps1");
        if stale.exists() {
            let _ = std::fs::remove_file(&stale);
        }
        let (shell, args) = (spec.shell.as_path(), WATCHDOG_ARGS);
        // 与守卫任务同一行装配（`service_exec_line`）：引号规则只有一处。
        let tr = super::service_exec_line(shell, args);
        let r = crate::bounded::run(
            Command::new("schtasks").args([
                // 不提 /RL HIGHEST：看护跑的是用户态守卫入口，而最高权限在非提权进程里必被拒
                //   （与守卫任务同一理由，见 ensure_defined）。
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

/// 定义通道：计划任务（可即时 `/Run`）与登录自启项（免提权，只能等下次登录）。
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

/// 动作记录形如 `<通道>\t<动作串>`。无制表符的旧格式按**计划任务**解读（那是它当时唯一的
/// 通道），否则升级后会把已装用户的任务判成过时并白重建一次。
/// 退役依据：带通道前缀是自 v1.2.3 起的唯一写入形态（见 `write_action_record`），旧记录只可能在
/// 更早装机升上来、且尚未重装过通道时读到。退役期限 v1.4，删除前置 = 活跃装机最低版本 >= 1.2.3。
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

/// 权限类失败：只有这一类值得换通道，参数/策略类失败重试同一条命令不会变好。
/// 中英 Windows 的同一事实（`schtasks` 的 stderr 已由 bounded 按控制台码页解码）。
fn is_access_denied(text: &str) -> bool {
    let t = text.to_lowercase();
    text.contains("拒绝访问") || t.contains("access is denied") || t.contains("access denied")
}

/// HKCU 的 Run 键与其中的值名：标准用户可写，不需要任何提权。
const RUN_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
const RUN_VALUE: &str = "DSH Supervisor";

impl ServiceControl for Impl {
    fn kind(&self) -> &'static str {
        "schtasks"
    }

    fn definition_path(&self) -> PathBuf {
        // 计划任务不是文件；返回标识串供日志/诊断。
        // 正因如此，**不能**用 `definition_path().is_file()` 判断「定义是否存在」
        //   （恒 false，会让 --service-plan 自检误报）—— 见下面的 is_defined 覆写。
        PathBuf::from(format!("schtasks://{}", GUARD_TASK))
    }

    /// Windows 覆写默认判定：`schtasks /Query` 成功即计划任务存在（标识串用 is_file() 恒 false）。
    fn is_defined(&self) -> bool {
        matches!(
            crate::bounded::run(
                Command::new("schtasks").args(["/Query", "/TN", GUARD_TASK]),
                SVC_QUICK,
            ),
            Ok(o) if o.success
        )
    }

    /// 建立守卫定义（幂等，且动作或通道过时时自愈）。计划任务本身回读不到动作串，
    ///   故本地留一份动作记录比对；若以「Query 成功即返回」当完成，修复永远到不了已装用户。
    fn ensure_defined(&self, spec: &LaunchSpec) -> Result<String, String> {
        let task_exists = self.is_defined();
        // 计划任务只指向稳定入口 `<壳> --run-guard`，定义不含 node/guard 路径
        //   （固化路径在 node 迁移即失效），检测由 --run-guard 在每次启动时完成。
        let (shell, args) = spec.service_command();
        let action = super::service_exec_line(shell, args);
        let record = crate::env::supervisor_dir().join("guard-task.action");
        if let Some(dir) = record.parent() {
            std::fs::create_dir_all(dir).map_err(|e| format!("创建状态目录失败: {}", e))?;
        }
        let (channel, recorded) = read_action_record(&record);
        if task_exists && channel == Some(Channel::Task) && recorded == action {
            // 即使守卫任务已是最新，也必须确保**壳拥有的看护任务**存在（幂等）。
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
            // 免提权兜底：HKCU 登录自启项。它不能被即时启动（`start` 如实返回 Err，调用方
            //   据此走直接拉起），但「下次登录拉起守卫」这条能力得以保留。
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
        // 定义写在哪个通道，就向哪个通道请求启动：对只存在于 Run 键的守卫发 `/Run`，
        //   得到的是「找不到任务」，那会把兜底通道伪装成服务管理器故障。
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
        // 看护任务必须 /Delete 整条计划：/End 只结束本次实例，/SC MINUTE /MO 5 的计划
        //   仍会在 5 分钟内再次触发把守卫拉回来。删除后下次 ensure_defined 幂等重建。
        //   全部有界：退出流程也要能在服务管理器无响应时走完。
        crate::bounded::run_lossy(
            Command::new("schtasks").args(["/Delete", "/TN", WATCHDOG_TASK, "/F"]),
            SVC_NORMAL,
        );
        crate::bounded::run_lossy(
            Command::new("schtasks").args(["/End", "/TN", GUARD_TASK]),
            SVC_NORMAL,
        );
        // 守卫镜像名是 node.exe（不是 dsh-supervisor.exe），按镜像名 taskkill 杀不到它；
        //   按命令行含 dsh-supervisor 精确匹配再杀，绝不误杀 DSH 自身的 node。
        crate::bounded::run_lossy(
            Command::new("powershell").args([
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*dsh-supervisor*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }",
            ]),
            SVC_NORMAL,
        );
        Ok(())
    }

}

/// 盘符是否为固定磁盘（结果按盘符缓存，每个盘符最多查询一次）。
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
    root[1] = 58; // 冒号
    root[2] = 92; // 反斜杠
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
    //! Windows 工具链事实的行为门禁：本模块只在 Windows 上编译才成立 ——
    //! `.cmd` 能否被 CreateProcessW 拉起、官方 zip 解出来 npm 载荷完不完整，
    //! 都是只有本平台能判定的事实，这些断言在 Linux/macOS 上恒真、写在那里等于没写。

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
        // 这三个都在官方 zip 的 node 目录里，且全都「文件存在而拉不起来」。
        assert!(!p.is_directly_spawnable(Path::new("C:\\node\\npm.cmd")));
        assert!(!p.is_directly_spawnable(Path::new("C:\\node\\npm.bat")));
        assert!(!p.is_directly_spawnable(Path::new("C:\\node\\npm")));
    }

    #[test]
    fn cmd_shim_alone_is_not_reported_as_npm() {
        // 截断/裁剪后的现场：node.exe 与 npm.cmd 在，包内 JS 树没了。
        //   只剩不可直接执行的垫片时必须判为不就绪，不得经 cmd 包装后当作可用。
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
        // 官方 zip 完整形态：npm.cmd / npm / node_modules\npm\bin\npm-cli.js 并存。
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
        // 半成品不得落定：这是「Node 已就绪而 npm 不在」的最后一道闸。
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
        // 候选清单是错误文案与 probe_npm 的共用事实源：拼进 bin_dir 后不得跑出该目录。
        let bin = Path::new("C:\\node");
        for p in npm_shim_candidates(bin) {
            assert_eq!(p.parent(), Some(bin), "候选必须是 bin 目录内的裸文件名");
            assert!(p.file_name().is_some());
        }
    }

    /// 真机取证：下载官方归档并走生产解包路径，断言解出来的 npm 真实可用。
    /// zip -> node_modules\\npm -> `npm --version` 整条链不被 CI 构建与门禁触碰（不碰真归档），
    /// 故由 build.yml 的 Windows leg 以 `--ignored` 显式执行。
    #[test]
    #[ignore = "联网下载官方 Node 归档（约 30MB），仅由 CI 的 Windows leg 执行"]
    fn official_artifact_installs_usable_npm() {
        let home = tmp("e2e");
        std::env::set_var("DSH_SUPERVISOR_HOME", &home);
        let choice = crate::node::latest_lts().expect("镜像发现失败");
        let dl = home.join("dl");
        // 顺手钉住**字节进度**本身：这是真机才有的量（本地无网络）。
        // 只报一次、或收尾量与落盘大小不符，都说明进度是假的。
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
        // 每次心跳都不得超过真实落盘量：超过就说明进度是凭空长出来的。
        assert!(
            b.iter().all(|(got, _)| *got <= size),
            "心跳报出了比归档本身还大的字节量：{:?}",
            b.iter().map(|x| x.0).collect::<Vec<_>>()
        );
        // 刻意**不**断言全局单调：换源重下（`download_verified` 的镜像回退）合法地把已取回量
        //   退回 0，而那正是该报给用户看的「重新开始」。单次尝试内的单调性由
        //   `http_get_bytes_progress` 的累加结构保证，把它写成真机断言只会平添网络抖动导致的误红。
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
    //! 定义通道的形态门禁：权限类判定与通道记录是 Windows 拉起链唯一的分支点，
    //! 判错的代价是用户看到「两次同样的拒绝访问」而不说原因。

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
        // 旧格式（只有动作串）按计划任务解读：升级不该把已装用户的任务判成过时再重建一次。
        std::fs::write(&p, r#""C:\x\dsh.exe" --run-guard"#).unwrap();
        assert_eq!(read_action_record(&p).0, Some(Channel::Task), "旧记录未按计划任务解读");
        // CRLF 与尾随换行不改变判定（记录由本模块写，但可能被人手工编辑过）。
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
