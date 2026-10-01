//! 面板与壳的消息桥契约：内容 iframe 内 Tauri IPC 仅主帧可用，内核更新请求须经受校验的 postMessage 通道转交壳主帧。版本与消息类型的唯一事实源在此，经 shell_bridge_contract 下发给 shell.html。

/// 协议版本；任何语义变更都必须递增。
/// 波 3（契约字段改名）改了消息类型名（换成我方前缀）—— 消息名是**线上值**，改名即语义变更 ⇒ 1 → 2。
pub const KERNEL_UPDATE_PROTOCOL_VERSION: u32 = 2;

// 消息类型名的**唯一事实源**是 `crate::brand`（与内核 `core/src/shared/brand.js` 逐字一致，由
//   core/test/brand-single-source-test.js 对账）：面板 bundle 是内核产物、本文件是壳产物，两侧各自独立发布，
//   所以名字不能在这里再写一遍字面量 —— 只改一侧就是「更新按钮没反应」且没有任何报错。
pub const MSG_KERNEL_UPDATE_REQUEST: &str = crate::brand::BRIDGE_MSG_KERNEL_UPDATE_REQUEST;

pub const MSG_KERNEL_UPDATE_RESULT: &str = crate::brand::BRIDGE_MSG_KERNEL_UPDATE_RESULT;

/// 非终结、可多次；不递增协议版本。
pub const MSG_KERNEL_UPDATE_PROGRESS: &str = crate::brand::BRIDGE_MSG_KERNEL_UPDATE_PROGRESS;

pub const CMD_KERNEL_UPDATE_APPLY: &str = "kernel_update_apply";

/// 内核安装（逐源尝试）的总时间预算：与 core_apply_inner 的 deadline 共用定义；下游上界由 [`KERNEL_UPDATE_MAX_WAIT_MS`] 派生 —— 引导页兜底常量 CORE_APPLY_BUDGET_MS 必须等于它。
pub const KERNEL_UPDATE_BUDGET_MS: u64 = 17 * 60 * 1000;

pub const KERNEL_UPDATE_GRACE_MS: u64 = 60 * 1000;

pub const KERNEL_UPDATE_MAX_WAIT_MS: u64 = KERNEL_UPDATE_BUDGET_MS + KERNEL_UPDATE_GRACE_MS;

