//! Linux 平台实现（systemd --user）。
//!
//! 本文件是 Linux 的**全部**平台知识 —— 其它任何文件都不应出现 `target_os = "linux"`（门禁 G1）。

use std::path::{Path, PathBuf};
use std::process::Command;

use super::service::ServiceControl;
use super::{home_dir, user_name, Capabilities, LaunchSpec, Platform, SVC_NORMAL, SVC_QUICK};

pub const NAME: &str = "linux";

/// 安装命令超时（15 分钟：下载 + 解包）。
const INSTALL_CMD_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15 * 60);

/// Linux 可用提权通道（按优先级）。单一事实源，只由 `has_privilege_channel()` 使用。
/// 提权唯一消费者是壳自更新（deb 落系统目录），探测与实际执行必须同源。
/// Node 安装刻意不经过这里：它解到用户级状态目录，零权限（门禁 A-2）。
pub const PRIVILEGE_COMMANDS: [&str; 2] = ["pkexec", "sudo"];

/// 在 PATH 中定位第一个可用的提权命令（不执行，只判存在性）。
/// 返回 None 表示两种通道都没有，调用方据此给出明确的环境错误。
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
            native_service: true, // systemd --user
            // 声明与实测必须同源：改为调用同一个探测函数。
            privilege_channel: self.has_privilege_channel(), // 仅壳自更新用；Node 安装已改为用户级、零权限
            node_artifact: "tar.gz",
        }
    }

    fn core_platform_tag(&self) -> Option<&'static str> {
        // 与 node_artifact 同一套 ARCH 归一；未知架构如实返回 None。
        match std::env::consts::ARCH {
            "x86_64" => Some("linux-x64"),
            "aarch64" => Some("linux-arm64"),
            _ => None,
        }
    }

    fn node_artifact(&self, version: &str) -> Option<super::NodeArtifact> {
        // 官方 files[] 两个标签都存在；未知架构返回 None（如实报「无可用制品」），绝不静默当 x64。
        let arch = match std::env::consts::ARCH {
            "x86_64" => "x64",
            "aarch64" => "arm64",
            _ => return None,
        };
        let tag = if arch == "arm64" { "linux-arm64" } else { "linux-x64" };
        Some(super::NodeArtifact {
            tag,
            // 用 .tar.gz：gzip 普遍可用，不再依赖 xz（原 .tar.xz 在无 xz 的机器上必失败）。
            file: format!("node-v{}-linux-{}.tar.gz", version, arch),
        })
    }

    fn node_candidate_paths(&self) -> Vec<PathBuf> {
        let mut v = vec![
            // 用户级安装（<状态根>/node）最先：壳自己装的，优先于系统其它 Node。
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
        // 用户级安装落点（零权限）；不再指向 /usr/local（那需要 pkexec/sudo）。
        crate::env::node_install_root().join("bin").join("node")
    }

    fn is_usable_executable(&self, cand: &Path) -> bool {
        cand.is_file()
    }

    fn install_node(&self, file: &Path) -> Result<PathBuf, String> {
        // 用户级解包（tar.gz 解到 <状态根>/node），零权限，不需要 pkexec/sudo；
        //   容器/WSL/SSH 上常无可用 polkit agent 或 sudo，提权路径在那类环境必然装不上。
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

    fn core_extra_candidates(&self, _names: &[&str], _pkg: Option<&str>) -> Vec<PathBuf> {
        // Linux：PATH 与 ~/.local/bin（内核 install 写入的软链）已覆盖全部落点。
        Vec::new()
    }

    fn is_local_fixed_dir(&self, _dir: &Path) -> bool {
        // Unix：无「网络盘 / 可移动盘」概念上的 is_file() 触网风险，
        // 本地文件系统调用不会因路径本身而阻塞数十秒。
        true
    }

    fn has_privilege_channel(&self) -> bool {
        // 不主动执行提权，只探测命令存在性（供壳自更新「能否提权」的提前判定）。
        find_privilege_command().is_some()
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
        "systemd"
    }

    fn definition_path(&self) -> PathBuf {
        home_dir()
            .join(".config")
            .join("systemd")
            .join("user")
            .join("dsh-supervisor.service")
    }

    /// 建立 systemd 用户单元（幂等，且内容过时时自愈）：
    /// 先算期望内容与磁盘比对，不存在则写入并首次启用、不同则只重写定义、一致则不触碰。
    fn ensure_defined(&self, spec: &LaunchSpec) -> Result<String, String> {
        let path = self.definition_path();
        // 模板内嵌（不依赖外部 systemd/*.service 文件）。
        // ExecStart 的可执行路径必须自带引号：systemd 对第一个参数按 shell-like 规则解析，
        //   未加引号的空格会把含空格的家目录拆成两段；引号写在值内部，与给 Rust args 加引号不同。
        // ExecStart 只指向稳定入口 <壳> --run-guard；node/guard 不写进 unit，由 --run-guard 每次启动重新检测。
        let (shell, args) = spec.service_command();
        let exec_start = crate::platform::service_exec_line(shell, args);
        let body = "[Unit]\nDescription=dsh-supervisor - DSH lifecycle guard\nAfter=network.target\nStartLimitIntervalSec=600\nStartLimitBurst=3\n\n[Service]\nType=simple\nEnvironment=\"DSH_SUPERVISOR_HOME=@ROOT@\"\nExecStart=@EXEC@\nRestart=always\nRestartSec=5\nKillMode=process\n\n[Install]\nWantedBy=default.target\n"
            .replace("@ROOT@", &spec.state_root.display().to_string())
            .replace("@EXEC@", &exec_start);
        // 内容比对：决定「新写」「重写」还是「不动」
        let existing = std::fs::read_to_string(&path).ok();
        let needs_write = match &existing {
            Some(cur) => cur != &body, // 存在但内容过时 -> 重写（自愈）
            None => true,              // 不存在 -> 新建
        };
        if !needs_write {
            // 真正的幂等：内容一致就不动盘、不 reload（避免每次启动都触发 daemon-reload）。
            return Ok(format!("已存在且为最新 {}", path.display()));
        }
        let is_update = existing.is_some();
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| format!("创建 systemd 目录失败: {}", e))?;
        }
        std::fs::write(&path, &body).map_err(|e| format!("写入 unit 失败: {}", e))?;
        // 全部经 bounded::run：超时即返回，绝不把引导挂在 systemctl 上。
        crate::bounded::run_lossy(
            Command::new("systemctl").args(["--user", "daemon-reload"]),
            SVC_QUICK,
        );
        // 自愈重写只换定义，绝不重放 enable/enable-linger：自启开关的唯一写者是内核面板（D5）。
        //   在升级路径上重放 = 用户关掉自启后，任何一次模板演进都会把它偷偷打开。
        if is_update {
            return Ok(format!("已更新定义（自启位未改动） {}", path.display()));
        }
        let en = crate::bounded::run(
            Command::new("systemctl").args(["--user", "enable", "dsh-supervisor.service"]),
            SVC_NORMAL,
        );
        // linger：未登录也保持用户服务（否则注销后守卫停止）。
        crate::bounded::run_lossy(
            Command::new("loginctl").arg("enable-linger").arg(user_name()),
            SVC_NORMAL,
        );
        // 注意：enable 失败不算致命 —— 服务定义已写入，start 时仍可拉起（并另有 spawn 兜底）。
        // 故这里只如实描述状态，不返回 Err（否则会把「可继续」的情形误判为彻底失败）。
        match en {
            Ok(o) if o.success => Ok(format!("已建立并启用 {}", path.display())),
            Ok(o) => Ok(format!(
                "已建立（enable 未成功：{}，start 时重试）{}",
                o.stderr.trim(),
                path.display()
            )),
            Err(e) => Ok(format!(
                "已建立（enable 超时/失败：{}，start 时重试）{}",
                e,
                path.display()
            )),
        }
    }

    fn start(&self) -> Result<(), String> {
        crate::bounded::run_checked(
            Command::new("systemctl").args(["--user", "start", "dsh-supervisor"]),
            SVC_NORMAL,
            "systemctl --user start dsh-supervisor",
        )
        .map(|_| ())
    }

    fn stop(&self) -> Result<(), String> {
        crate::bounded::run_checked(
            Command::new("systemctl").args(["--user", "stop", "dsh-supervisor"]),
            SVC_NORMAL,
            "systemctl --user stop",
        )
        .map(|_| ())
    }

}

#[cfg(test)]
mod tests {
    //! A-2 行为门禁：提权通道的探测只认 PATH 里真实存在的命令（不再做源码文本断言）。
    use super::*;

    /// A-2（行为）：find_privilege_command 只认 PATH 里**真实存在**的命令。
    #[test]
    fn a2_find_privilege_command_respects_path() {
        // 空 PATH -> 必然 None（不依赖机器上是否真有 pkexec/sudo）
        let saved = std::env::var_os("PATH");
        std::env::set_var("PATH", "");
        let none = find_privilege_command();
        // 恢复 PATH（后续测试可能依赖）
        match &saved {
            Some(p) => std::env::set_var("PATH", p),
            None => std::env::remove_var("PATH"),
        }
        assert!(none.is_none(), "A-2 FAIL 空 PATH 下仍报告有提权通道: {:?}", none);

        // 造一个只含伪 pkexec 的临时目录 -> 必须命中它
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