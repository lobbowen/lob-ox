//! 相位状态机（机箱唯一真相，取代内核 ManagedRegistry 相位）。
//!
//! 相位集合全域唯一：stopped / starting / running / draining / failed / restarting。
//! 「重启退避」是框架策略（窗口内 N 次失败 ⇒ failed，停手等人工），不随内核变化。

use std::time::Instant;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Phase { Stopped, Starting, Running, Draining, Failed, Restarting }

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Desired { Running, Stopped }

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RestartBackoff { None, Tripped }

/// 崩溃 last-will：记录子进程为何退出，供引导页诊断（不靠循环拉起来掩盖故障）。
#[derive(Debug, Clone)]
pub struct LastWill {
    pub code: Option<i32>,
    pub signal: Option<String>,
    pub at: Instant,
}

#[derive(Debug, Clone)]
pub struct WorkloadDesc {
    pub id: String,
    /// 机箱只持有「机制」：spawn 命令与重启策略；业务判定由内核负责。
    pub spawn_cmd: Vec<String>,
    pub restart_window_ms: u64,
    pub restart_burst: u32,
}

#[derive(Debug)]
pub struct WorkloadState {
    pub id: String,
    pub phase: Phase,
    pub desired: Desired,
    pub restart_backoff: RestartBackoff,
    pub pending_restart: bool,
    pub last_transition: Instant,
    pub last_will: Option<LastWill>,
    // 重启退避记账（框架策略，不随内核变化）：窗口内失败次数与窗口起点。
    // 真相在机箱：内核只上报「退出了」，是否该停手由机箱按窗口/次数判。
    pub fail_count: u32,
    pub window_start: Option<Instant>,
    pub restart_window_ms: u64,
    pub restart_burst: u32,
}

impl WorkloadState {
    pub fn from_desc(d: &WorkloadDesc) -> Self {
        WorkloadState {
            id: d.id.clone(),
            phase: Phase::Stopped,
            desired: Desired::Stopped,
            restart_backoff: RestartBackoff::None,
            pending_restart: false,
            last_transition: Instant::now(),
            last_will: None,
            fail_count: 0,
            window_start: None,
            restart_window_ms: d.restart_window_ms,
            restart_burst: d.restart_burst,
        }
    }
}
