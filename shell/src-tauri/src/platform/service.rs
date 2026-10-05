//! 服务管理器（监控器）契约 —— 产品自身的服务汇总 / 监控 / 生命周期 / 进程管理机制。
//!
//! 定位（唯一权威：见仓库根 STANDARDS.md 的「产品定位与术语规范」）：
//!   lob-ox 是一套 Agent 的跨平台管理面板。
//!   本契约描述的「服务管理器」与操作系统提供的任何服务机制
//!   （Windows 计划任务 / systemd / launchd）没有任何关系。
//!   产品不借用系统能力作为服务管理器，也不存在「用系统通道投递」的选项。
//!
//! 不变量：
//!   - 不支持的能力显式返回 Err，绝不静默成功；
//!   - 所有外部命令经 crate::bounded（超时即 kill）；
//!   - ensure_defined 幂等。

use std::path::PathBuf;

pub trait ServiceControl: Send + Sync {
    fn kind(&self) -> &'static str;

    fn definition_path(&self) -> PathBuf;

    /// 服务定义当前是否已存在。不能一律用 `definition_path().is_file()`：Windows 的"路径"是标识串，恒 false；Linux/macOS 走默认的文件存在性。
    fn is_defined(&self) -> bool {
        self.definition_path().is_file()
    }

    /// 建立服务定义（幂等），返回人类可读的状态描述。enable 失败不应返回 Err：定义已写入时 start 阶段仍可拉起，误判为「彻底失败」会让用户卡在引导页。
    fn ensure_defined(&self, spec: &crate::platform::LaunchSpec) -> Result<String, String>;

    fn start(&self) -> Result<(), String>;

    fn stop(&self) -> Result<(), String>;

    /// 服务管理器不可用（容器 / 无 user session / 策略拦截）时的直接 spawn 兜底。
    fn spawn_daemon(&self, spec: &crate::platform::LaunchSpec) -> Result<std::process::Child, String> {
        let mut cmd = std::process::Command::new(&spec.shell);
        cmd.arg("--run-guard")
            .env("DSH_SUPERVISOR_HOME", &spec.state_root);
        crate::platform::guard_stdio(&mut cmd);
        crate::bounded::prepare(&mut cmd);
        cmd.spawn().map_err(|e| {
            format!("直接拉起守卫失败: {}（{} --run-guard）", e, spec.shell.display())
        })
    }
}
