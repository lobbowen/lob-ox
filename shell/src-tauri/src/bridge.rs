pub const KERNEL_UPDATE_PROTOCOL_VERSION: u32 = 2;

// R8：消息名从 brand（shared-constants.json 单源）读。brand 的 shared_str 是运行期
// 函数，故这里是函数而非 const——消费方 commands/mod.rs 的 shell_bridge_contract
// 在同一调用内取值，不影响「单一事实源」目标。
pub fn msg_kernel_update_request() -> &'static str {
    crate::brand::bridge_msg_kernel_update_request()
}

pub fn msg_kernel_update_result() -> &'static str {
    crate::brand::bridge_msg_kernel_update_result()
}

pub fn msg_kernel_update_progress() -> &'static str {
    crate::brand::bridge_msg_kernel_update_progress()
}

pub const CMD_KERNEL_UPDATE_APPLY: &str = "kernel_update_apply";

pub const KERNEL_UPDATE_BUDGET_MS: u64 = 17 * 60 * 1000;

pub const KERNEL_UPDATE_GRACE_MS: u64 = 60 * 1000;

pub const KERNEL_UPDATE_MAX_WAIT_MS: u64 = KERNEL_UPDATE_BUDGET_MS + KERNEL_UPDATE_GRACE_MS;

