//! 遥测底座（壳侧公共记录层）。
//!
//! 定位：**系统里唯一的记录出口**。环境、内核引导、桌面自更新、窗口动作、
//! 进程管理全部经这里落盘，内核退化为业务编排、不再自带一套记录体系。
//!
//! 形态以内核既有实现（core/src/platform/service/log/events.js）为基准而非另造 ——
//! 那套已跑通并修过一次「永久丢事件」的数据正确性问题，其不变式必须整套照搬：
//!   · seq 只在**落盘成功后**前进，写失败下一条重试同一 seq；
//!   · 轮转用 rename + 单备份，并记下 rotatedSeq（增量读靠它决定是否扫备份）；
//!   · meta 原子写（writeAtomic），不必每次都写。
//! 壳侧此前只有 `update::log(line: &str)`：无级别、无序号、零读口，
//! 「轮转」是读全文截尾重写（非原子，且按 char 计数按字节判阈值）。

//! 分级：内核事件此前没有 level（无法表达「可降级」），这一维是壳侧必须补的 ——
//! 前端据此决定「退出」还是「横幅后继续」。
//!
pub mod event;
pub mod sink;
pub mod view;

use std::path::{Path, PathBuf};

/// 事件级别。决定消费侧的处置方式，不是给日志上色。
///
/// - `fatal`   继续下去必然不可用 —— 消费侧应终止流程；
/// - `error`   某个必需操作失败，但系统仍可能继续（由消费侧按上下文决定）；
/// - `warn`    某功能失效，整体可用 —— 消费侧降级继续，不打断用户；
/// - `info`    正常流转，仅供事后回溯。
///
/// 分级的判据是**后果**，不是严重感：拖不动标题栏（warn）与装不上内核（fatal）
/// 都不该用同一种处置。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Level {
    Info,
    Warn,
    Error,
    Fatal,
}

impl Level {
    /// 单字符标签，写进 JSON Lines 的 level 字段。
    pub fn tag(self) -> &'static str {
        match self {
            Level::Info => "info",
            Level::Warn => "warn",
            Level::Error => "error",
            Level::Fatal => "fatal",
        }
    }

    /// 解析；未知值按 `info` 处理（宁可降级也不误判为致命）。
    pub fn parse(s: &str) -> Level {
        match s {
            "fatal" => Level::Fatal,
            "error" => Level::Error,
            "warn" | "warning" => Level::Warn,
            _ => Level::Info,
        }
    }
}

/// 一条事件。字段与内核 events.js 同名同义，只有 level/producer 是壳侧扩展。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct Event {
    /// 事件类型，命名空间式（点分前缀即领域），如 `window.drag_failed`。
    #[serde(rename = "type")]
    pub kind: String,
    /// 事件负载。字段随 kind 而定，不做统一 schema。
    #[serde(default)]
    pub data: serde_json::Value,
    /// ISO-8601 UTC。与内核 `new Date().toISOString()` 同形 ——
    /// 此前壳侧用 Unix 秒，两侧时间戳无法直接比对。
    pub ts: String,
    /// 单调递增序号，仅在落盘成功后前进。
    #[serde(default)]
    pub seq: u64,
    /// 级别（壳侧扩展）。
    #[serde(default = "Level::default_tag")]
    pub level: String,
    /// 产出方。
    pub producer: Producer,
}

impl Event {
    pub fn new(kind: &str, level: Level, data: serde_json::Value) -> Event {
        Event {
            kind: kind.to_string(),
            data,
            ts: crate::telemetry::event::now_iso(),
            seq: 0,
            level: level.tag().to_string(),
            producer: Producer {
                process: "shell".to_string(),
                scope: String::new(),
            },
        }
    }
}

/// 事件产出方。`process` 区分壳与内核；`scope` 进一步定位到模块。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct Producer {
    pub process: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub scope: String,
}

impl Level {
    fn default_tag() -> String {
        "info".to_string()
    }
}

/// 记录文件路径。壳侧自己的事件与内核的 `guard.events.log` 分开：
/// 前者是壳的过程记录，后者是内核的业务事件，生命周期与消费者都不同。
pub fn shell_events_path() -> PathBuf {
    crate::env::shell_dir().join("shell.events.jsonl")
}

/// 内核原始 stdout/stderr 落点。**保持纯文本**：它不是事件流，
/// 而是子进程的原始输出，被 guard_log_tail() 原样拼进错误消息供人阅读。
pub fn guard_log_path() -> PathBuf {
    crate::env::shell_dir().join("guard.log")
}