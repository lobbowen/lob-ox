//! 探测中与探测失败 —— 这两种情况与「已得出结论」必须区分开。
//!
//! 此前 `node_status` / `system_node_ready` / `guard_ready` 把三种语义塞进一个扁平 JSON：
//!   · `installed` / `ready` / `minOk` 是**结论**；
//!   · `probing` / `stuck` 是**轮询控制位**（有界探测未完成，这是合法结果不是失败）；
//!   · `problem` / `probeError` / `npmWhy` 是**失败原因**。
//! 前端只能靠字段名猜每个字段属于哪一类 —— 这是整个错误体系失序的源头之一。
//!
//! 这里用类型把三件事一次说清：
//!   Ok(Probe::Settled(v))   查到了结论
//!   Ok(Probe::Pending{..})   仍在有界探测中（合法状态）
//!   Err(Fault)              探测失败（带 code/level/hint）
//!
//! 调用方 match 三个分支即可，无需猜字段语义。

use super::fault::Fault;

/// 探测结果。与 `Result<T, Fault>` 是同一个东西，
/// 区别只在于把「尚未得出结论」也纳入类型表达。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(untagged)]
pub enum Probe<T> {
    /// 有界探测尚未完成。不是失败 —— 探测有预算，超预算前仍在进行是正常的。
    Pending {
        /// 已用掉的探测预算（毫秒）。
        pub elapsed_ms: u64,
    },
    /// 已得出结论。
    Settled(T),
}

impl<T> Probe<T> {
    /// 取结论；仍在探测时返回 None。
    pub fn settled(&self) -> Option<&T> {
        match self {
            Probe::Settled(v) => Some(v),
            Probe::Pending { .. } => None,
        }
    }

    pub fn is_pending(&self) -> bool {
        matches!(self, Probe::Pending { .. })
    }
}

impl<T> Probe<T> {
    /// 把「有界探测未完成」映射为 pending，其它原样。
    ///
    /// 用于把既有的 `if out.finished { 结论 } else { 未完成 }` 形态
    /// 收敛成一处构造点，避免每个命令各写一遍判断。
    pub fn either(done: bool, pending_ms: u64, build: impl FnOnce() -> T) -> Probe<T> {
        if done {
            Probe::Settled(build())
        } else {
            Probe::Pending { elapsed_ms: pending_ms }
        }
    }
}