//! 面板与壳的消息桥契约：内容 iframe 内 Tauri IPC 仅主帧可用，内核更新请求须经受校验的
//! postMessage 通道转交壳主帧。版本与消息类型的唯一事实源在此，经 shell_bridge_contract 命令下发给 shell.html 使用（面板不得硬编码这些字面量）。

/// 协议版本。任何语义变更都必须递增；内核侧桥有同名常量并由门禁锁定。
pub const KERNEL_UPDATE_PROTOCOL_VERSION: u32 = 1;

pub const MSG_KERNEL_UPDATE_REQUEST: &str = "dsh:kernel-update-request";

pub const MSG_KERNEL_UPDATE_RESULT: &str = "dsh:kernel-update-result";

/// 非终结、可多次：旧面板本就丢弃该消息，补齐多帧不破坏版本兼容（故不递增协议版本）。
pub const MSG_KERNEL_UPDATE_PROGRESS: &str = "dsh:kernel-update-progress";

/// 壳主帧必须执行的 Tauri 命令名（安装内核，再重启守卫）。
pub const CMD_KERNEL_UPDATE_APPLY: &str = "kernel_update_apply";

/// 内核安装（逐源尝试）的总时间预算；与 core_apply_inner 的 deadline 共用定义。
/// 下游上界由 [`KERNEL_UPDATE_MAX_WAIT_MS`] 派生：引导页兜底常量 CORE_APPLY_BUDGET_MS 必须等于它。
pub const KERNEL_UPDATE_BUDGET_MS: u64 = 17 * 60 * 1000;

/// 预算之外的收尾余量（定位内核、写 core.json、停并重拉守卫），因此类步骤不在逐源 deadline 内。
pub const KERNEL_UPDATE_GRACE_MS: u64 = 60 * 1000;

pub const KERNEL_UPDATE_MAX_WAIT_MS: u64 = KERNEL_UPDATE_BUDGET_MS + KERNEL_UPDATE_GRACE_MS;

