//! macOS 平台实现（LaunchAgent + launchctl，门禁 G1 要求平台知识集中于此）。
//!
//! launchctl 子命令语义（易错，固定于此）：bootstrap 载入（RunAtLoad 立即启动、
//! KeepAlive 崩溃重启）；bootout 卸载；kickstart -k 重启；stop 用 bootout 会移除任务。

use std::path::{Path, PathBuf};
use std::process::Command;

use super::service::ServiceControl;
// 必须导入 SVC_QUICK：子模块不继承父模块作用域（漏导入 -> macOS 构建 E0425）。
use super::{home_dir, Capabilities, LaunchSpec, Platform, SVC_NORMAL, SVC_QUICK};

pub const NAME: &str = "macos";
/// 守卫的 LaunchAgent 标签（**定义由本文件建立**；内核只做 enable/disable）。
pub const GUARD_LABEL: &str = "com.dsh.supervisor";

/// bootstrap 脚本：域标签交给 shell 求值，plist 路径由 `"$1"` 位参传入而非拼进脚本文本。
const BOOTSTRAP_SCRIPT: &str = "launchctl bootstrap \"gui/$(id -u)\" \"$1\"";

/// 安装命令超时（15 分钟：下载 + installer + 管理员授权）。
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
            native_service: true, // launchd
            privilege_channel: true, // 仅壳自更新用；Node 安装已改为用户级、零权限
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
        // 用户级安装：官方 tarball 双架构齐全（osx-x64-tar / osx-arm64-tar），零权限。
        //   官方没有 osx-arm64-pkg 且 .pkg 需系统授权，故用 tar 归档而非 pkg。
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
            // 用户级安装（<状态根>/node）最先：壳自己装的，优先于系统其它 Node。
            self.node_bin_after_install(),
            PathBuf::from("/usr/local/bin/node"),
            // Apple Silicon 上的 Homebrew 落点（原生 arm64 安装常见于此）
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
        // 用户级安装落点（零权限）；不再指向 /usr/local（那需要管理员）。
        crate::env::node_install_root().join("bin").join("node")
    }

    fn is_usable_executable(&self, cand: &Path) -> bool {
        cand.is_file()
    }

    fn install_node(&self, file: &Path) -> Result<PathBuf, String> {
        // 用户级解包到 <状态根>/node，零权限（不需要管理员）。
        let root = crate::env::node_install_root();
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
        // Apple Silicon 与 Intel 的 Homebrew 落点。
        let mut v = Vec::new();
        for name in names {
            v.push(PathBuf::from("/opt/homebrew/bin").join(name));
            v.push(PathBuf::from("/usr/local/bin").join(name));
        }
        v
    }

    /// macOS 状态根惯例：~/Library/Application Support/dsh-supervisor。
    fn state_root_default(&self) -> PathBuf {
        home_dir().join("Library").join("Application Support").join("dsh-supervisor")
    }

    fn is_local_fixed_dir(&self, _dir: &Path) -> bool {
        // Unix：无「网络盘 / 可移动盘」概念上的 is_file() 触网风险，
        // 本地文件系统调用不会因路径本身而阻塞数十秒。
        true
    }

    fn has_privilege_channel(&self) -> bool {
        // macOS 的 osascript 管理员授权**恒可用**（无需额外命令）。
        true
    }

    // 可执行文件名的平台差异（P2/G1：原为平台层之外的 cfg!() 宏）
    fn node_exe_name(&self) -> &'static str { "node" }
    fn npm_exe_name(&self) -> &'static str { "npm" }
    fn core_exe_names(&self) -> &'static [&'static str] { &["dsh-supervisor"] }
    // execve 按 shebang 解释脚本，npm 垫片因此可直接 spawn。
    fn is_directly_spawnable(&self, _prog: &Path) -> bool { true }
}

impl ServiceControl for Impl {
    fn kind(&self) -> &'static str {
        "launchagent"
    }

    fn definition_path(&self) -> PathBuf {
        home_dir()
            .join("Library")
            .join("LaunchAgents")
            .join(format!("{}.plist", GUARD_LABEL))
    }

    /// 建立 LaunchAgent plist 并 bootstrap（幂等，且内容过时时自愈）：
    /// 先算期望内容、与磁盘比对，一致不动、不同则重写并重新 bootstrap。
    fn ensure_defined(&self, spec: &LaunchSpec) -> Result<String, String> {
        let path = self.definition_path();
        // 日志落在产品状态根（独立于 DSH 的 ~/.dsh）。
        let log = crate::env::supervisor_dir().join("log").join("guard-stdio.log");
        // plist 是 XML：路径嵌入前必须转义 &、<、>（家目录可含它们，未转义则
        //   bootstrap 报含糊 syntax error、自启静默失效）。& 必须最先替换，否则二次转义。
        let xml_escape = |s: &str| -> String {
            s.replace('&', "&amp;")
                .replace('<', "&lt;")
                .replace('>', "&gt;")
        };
        // ProgramArguments 只指向稳定入口 <壳> --run-guard；node/guard 不写进 plist，
        //   由 --run-guard 每次启动重新检测，launchd 的 PATH 与否不再影响启动。
        let (shell, args) = spec.service_command();
        let mut prog = format!("<string>{}</string>", xml_escape(&shell.display().to_string()));
        for a in args {
            prog.push_str(&format!("<string>{}</string>", xml_escape(a)));
        }
        let body = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n<plist version=\"1.0\"><dict>\n  <key>Label</key><string>com.dsh.supervisor</string>\n  <key>ProgramArguments</key>\n  <array>@PROG@</array>\n  <key>EnvironmentVariables</key><dict><key>DSH_SUPERVISOR_HOME</key><string>@ROOT@</string></dict>\n  <key>RunAtLoad</key><true/>\n  <key>KeepAlive</key><true/>\n  <key>ProcessType</key><string>Interactive</string>\n  <key>StandardOutPath</key><string>@LOG@</string>\n  <key>StandardErrorPath</key><string>@LOG@</string>\n</dict></plist>\n"
            .replace("@PROG@", &prog)
            .replace("@ROOT@", &xml_escape(&spec.state_root.display().to_string()))
            .replace("@LOG@", &xml_escape(&log.display().to_string()));
        // 内容比对：决定「新写」「重写」还是「不动」
        let existing = std::fs::read_to_string(&path).ok();
        let needs_write = match &existing {
            Some(cur) => cur != &body,
            None => true,
        };
        let is_update = existing.is_some();
        if !needs_write {
            return Ok(format!("已存在且为最新 {}", path.display()));
        }
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| format!("创建 LaunchAgents 目录失败: {}", e))?;
        }
        if let Some(dir) = log.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        std::fs::write(&path, &body).map_err(|e| format!("写入 plist 失败: {}", e))?;
        // 内容变了必须重新加载：先 bootout 旧的再 bootstrap 新的，否则 launchd 仍跑旧定义。
        if is_update {
            let off = format!("launchctl bootout gui/$(id -u)/{}", GUARD_LABEL);
            crate::bounded::run_lossy(Command::new("sh").args(["-c", &off]), SVC_QUICK);
        }
        // bootstrap 会因 RunAtLoad 立即启动；KeepAlive 负责崩溃重启。
        // plist 路径经 "$1" 传入而不是拼进脚本：用户名/路径里出现 `$`、反引号或引号时，
        // 拼串形态会被 shell 二次解释（bootstrap 打到错误目标，且是静默的）。
        let p = path.display().to_string();
        let out = crate::bounded::run(
            Command::new("sh").args(["-c", BOOTSTRAP_SCRIPT, "sh", p.as_str()]),
            SVC_NORMAL,
        );
        let verb = if is_update { "已更新并加载" } else { "已建立并加载" };
        match out {
            Ok(o) if o.success => Ok(format!("{} {}", verb, path.display())),
            Ok(o) => Ok(format!(
                "{}（bootstrap 未成功: {}，start 时重试）{}",
                verb,
                o.stderr.trim(),
                path.display()
            )),
            Err(e) => Ok(format!("{}（bootstrap 超时/失败: {}）{}", verb, e, path.display())),
        }
    }

    fn start(&self) -> Result<(), String> {
        // `kickstart -k` = 若在运行则先杀再启，否则启动。
        // 若任务已被 `stop`（bootout）移除，kickstart 会失败 -> 退回 bootstrap 兜底。
        let uid = "$(id -u)";
        let kick = format!("launchctl kickstart -k gui/{}/{}", uid, GUARD_LABEL);
        let r = crate::bounded::run(Command::new("sh").args(["-c", &kick]), SVC_NORMAL);
        if matches!(&r, Ok(o) if o.success) {
            return Ok(());
        }
        let path = self.definition_path();
        if !path.is_file() {
            return Err(format!(
                "launchctl kickstart 失败且无 plist 可 bootstrap（路径 {}）",
                path.display()
            ));
        }
        let p = path.display().to_string();
        let b = crate::bounded::run(Command::new("sh").args(["-c", BOOTSTRAP_SCRIPT, "sh", p.as_str()]), SVC_NORMAL);
        match b {
            Ok(o) if o.success => Ok(()),
            Ok(o) => Err(format!(
                "launchctl bootstrap 失败（重启兜底）：{}",
                o.stderr.trim()
            )),
            Err(e) => Err(format!("launchctl bootstrap 超时/失败：{}", e)),
        }
    }

    fn stop(&self) -> Result<(), String> {
        let cmd = format!("launchctl bootout gui/$(id -u)/{}", GUARD_LABEL);
        crate::bounded::run_checked(
            Command::new("sh").args(["-c", &cmd]),
            SVC_NORMAL,
            "launchctl bootout",
        )
        .map(|_| ())
    }

}