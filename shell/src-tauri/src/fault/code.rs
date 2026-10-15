//! 故障码词表。
//!
//! 词表来源是两处既有词汇表，本模块只做归一与参数化，不新造码：
//!  · ShellError 的 7 个 kind（error.rs）；
//!  · LaunchError 的 8 个 code（domain/guardctl.rs）。
//! 它们在排障时已被使用（用户报码、文档引用），改名字等于让既有知识失效。
//!
//! 命名：`域.语义`，点分前缀即领域 —— 与内核事件的 type 命名空间同风格，
//! 便于两套记录用同一套 grep 习惯查。

use crate::telemetry::Level;

/// 一个故障码：稳定标识 + 处置级别。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Code {
    /// 稳定标识，跨版本不变。
    pub id: &'static str,
    /// 消费侧处置依据。
    pub level: Level,
}

const fn c(id: &'static str, level: Level) -> Code {
    Code { id, level }
}

/// 无法归类的失败。**不判 fatal** —— 认不出来的故障不该让系统自杀。
pub const UNKNOWN: Code = c("unknown", Level::Error);

// ── 环境（Node / 契约）────────────────────────────────────────────
pub const RUNTIME_MISSING: Code = c("env.runtime_missing", Level::Fatal);
pub const NODE_UNUSABLE: Code = c("env.node_unusable", Level::Fatal);
pub const NPM_UNUSABLE: Code = c("env.npm_unusable", Level::Warn);

// ── 内核 ──────────────────────────────────────────────────────────
pub const KERNEL_MISSING: Code = c("kernel.missing", Level::Fatal);
pub const LAUNCH_SPEC_FAILED: Code = c("kernel.launch_spec_failed", Level::Fatal);
pub const KERNEL_SPAWN_FAILED: Code = c("kernel.spawn_failed", Level::Fatal);
pub const KERNEL_EXITED: Code = c("kernel.exited", Level::Error);
pub const DAEMON_EXITED_UNREADY: Code = c("kernel.daemon_exited_unready", Level::Error);
pub const READY_TIMEOUT: Code = c("kernel.ready_timeout", Level::Error);
pub const JOIN_ERROR: Code = c("kernel.join_error", Level::Error);

// ── 网络 / 镜像 / 下载 ────────────────────────────────────────────
pub const PROBE_TIMEOUT: Code = c("net.probe_timeout", Level::Warn);
pub const NETWORK_FAILED: Code = c("net.failed", Level::Error);
pub const TRANSFER_FAILED: Code = c("net.transfer_failed", Level::Error);

// ── 安装 ──────────────────────────────────────────────────────────
pub const INSTALL_FAILED: Code = c("install.failed", Level::Fatal);

// ── 契约 ──────────────────────────────────────────────────────────
pub const CONTRACT_INVALID: Code = c("contract.invalid", Level::Error);

// ── IPC / 权限 ────────────────────────────────────────────────────
pub const IPC_PARAM_INVALID: Code = c("ipc.param_invalid", Level::Error);
/// ACL 拒绝等**能力不可用**：这是 warn 而非 fatal ——
/// 拖不动标题栏不该终止整个应用。此前它经 unhandledrejection 升级成 fatal，
/// 直接导致壳无限重启。
pub const CAPABILITY_DENIED: Code = c("acl.denied", Level::Warn);
pub const UNSUPPORTED: Code = c("platform.unsupported", Level::Warn);

/// 按 id 查码；未知 id 归为 Error 而非 Fatal ——
/// 认不出来的故障不该让系统自杀。
pub fn lookup(id: &str) -> Code {
    let f = |x: Code| if x.id == id { Some(x) } else { None };
    for code in [
        RUNTIME_MISSING, NODE_UNUSABLE, NPM_UNUSABLE,
        KERNEL_MISSING, LAUNCH_SPEC_FAILED, KERNEL_SPAWN_FAILED, KERNEL_EXITED,
        DAEMON_EXITED_UNREADY, READY_TIMEOUT, JOIN_ERROR,
        PROBE_TIMEOUT, NETWORK_FAILED, TRANSFER_FAILED,
        INSTALL_FAILED, CONTRACT_INVALID,
        IPC_PARAM_INVALID, CAPABILITY_DENIED, UNSUPPORTED,
    ] {
        if let Some(x) = f(code) {
            return x;
        }
    }
    c("unknown", Level::Error)
}