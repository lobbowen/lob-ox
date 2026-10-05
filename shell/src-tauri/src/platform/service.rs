//! 服务管理器（= 产品自身的监控器）契约。
//!
//! 定位（唯一权威：见仓库根 STANDARDS.md 的「产品定位与术语规范」）：
//!   lob-ox 是一套 Agent 的跨平台管理面板，向下监管一批服务
//!   （内核自身 / DSH 主实例 / 路由 daemon / 局域网 daemon / 沙箱实例 / 插件）。
//!   本契约描述的「服务管理器」是**产品自己建立**的机制，与操作系统提供的任何服务机制
//!   （Windows 计划任务 / systemd / launchd）**没有任何关系**：
//!     - 它不是 OS 服务机制的封装或借用；
//!     - **不存在「用系统通道投递服务」这个选项**；
//!     - 全仓不得出现 schtasks / systemctl / launchctl / LaunchAgent 一类的调用。
//!   它统一负责：向下所有子服务模块的**汇总、监控、生命周期管理、进程管理**。
//!
//! 两面分工（同一套机制的两个面，不得混用）：
//!   - **生命周期 / 进程管理**（本 trait）：接管（adopt）、启动、停止、汇总。产品自己
//!     持有子进程，不委托 OS。
//!   - **监控**（`crate::domain::guardctl` / `--watchdog`）：只观测（在不在 / 端口 / 版本 /
//!     健康），不做任何拉起、强杀、改生命周期的动作。
//!
//! 端口不变量：受管对象的真实端口在**接管时探测**（`crate::env::discovered_api_port` 读内核
//! 自报的 ports.json），不预设、不锁死 —— 为拉起而占用固定端口会让受管对象顺延不了端口。
//!
//! 不变量：
//!   - 不支持的能力显式返回 Err，绝不静默成功；
//!   - 所有外部命令经 crate::bounded（超时即 kill）；
//!   - ensure_defined 幂等。

use std::path::PathBuf;

pub trait ServiceControl: Send + Sync {
    /// 本平台监控器的实现标识（诊断用，与任何 OS 机制无关）。
    fn kind(&self) -> &'static str;

    /// 监控器自身登记表的落点（产品状态根下），不是任何 OS 服务定义的位置。
    fn definition_path(&self) -> PathBuf;

    /// 登记表当前是否已存在。不能一律用 `definition_path().is_file()`：各平台登记的形态
    /// 不同（Windows 下是标识串，恒 false），故由实现自行回答。
    fn is_defined(&self) -> bool {
        self.definition_path().is_file()
    }

    /// 建立登记表（幂等），返回人类可读的状态描述。失败不返回 Err：登记写不进去时
    /// 启动阶段仍可直接拉起，误判为「彻底失败」会让用户卡在引导页。
    fn ensure_defined(&self, spec: &crate::platform::LaunchSpec) -> Result<String, String>;

    fn start(&self) -> Result<(), String>;

    fn stop(&self) -> Result<(), String>;

    /// 产品自身的进程管理：直接拉起受管对象。这是**正式路径**，不是「兜底」——
    /// 服务管理器不向 OS 投递任何东西，进程由本产品自己持有。
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
