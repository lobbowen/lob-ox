//! 相位状态机（机箱唯一真相，取代内核 ManagedRegistry 相位）。
//!
//! 相位集合全域唯一：stopped / starting / running / draining / failed / restarting。

use std::time::Instant;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Phase { Stopped, Starting, Running, Draining, Failed, Restarting }

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Desired { Running, Stopped }

/// 自愈优先级：数值越小越优先。内核是产品存活的前提，故最高；其余按依赖次序递减。
/// 所有受管对象都有自愈，区别只在优先级 —— 预算紧张时低优先级让位于高优先级。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Priority {
    /// 内核：没有它整个产品不工作，自愈最优先、预算最长。
    Core = 0,
    /// 路由 daemon：内核起来后对外暴露的入口。
    Router = 1,
    /// 局域网 daemon。
    Lan = 2,
    /// 沙箱实例。
    Sandbox = 3,
    /// 插件。
    Plugin = 4,
}

impl Priority {
    /// 自愈预算（毫秒）：高优先级给更长窗口，低优先级更短 —— 同一套机制按优先级分级。
    pub fn heal_budget_ms(self) -> u64 {
        match self {
            Priority::Core => 120_000,
            Priority::Router => 60_000,
            Priority::Lan => 60_000,
            Priority::Sandbox => 30_000,
            Priority::Plugin => 30_000,
        }
    }

    /// 连续失败多少次后停手等人工（避免无意义高频重启）。
    pub fn heal_burst(self) -> u32 {
        match self {
            Priority::Core => 5,
            Priority::Router => 3,
            Priority::Lan => 3,
            Priority::Sandbox => 2,
            Priority::Plugin => 2,
        }
    }
}

/// 崩溃 last-will：记录子进程为何退出，供引导页诊断。
#[derive(Debug, Clone)]
pub struct LastWill {
    pub code: Option<i32>,
    pub signal: Option<String>,
    pub at: Instant,
}

#[derive(Debug, Clone)]
pub struct WorkloadDesc {
    pub id: String,
    /// 机箱只持有「机制」：spawn 命令与自愈优先级；业务判定由内核负责。
    pub spawn_cmd: Vec<String>,
    pub priority: Priority,
}

#[derive(Debug)]
pub struct WorkloadState {
    pub id: String,
    pub phase: Phase,
    pub desired: Desired,
    pub priority: Priority,
    /// 壳自持路径下由壳拉起的进程；内核自报路径下为空（壳不持有其句柄）。
    pub spawn_cmd: Vec<String>,
    pub pid: Option<u32>,
    pub last_transition: Instant,
    pub last_will: Option<LastWill>,
    /// 自愈连续失败计数：达到 priority.heal_burst() 后停手。
    pub heal_failures: u32,
}

impl WorkloadState {
    pub fn from_desc(d: &WorkloadDesc) -> Self {
        WorkloadState {
            id: d.id.clone(),
            phase: Phase::Stopped,
            desired: Desired::Stopped,
            priority: d.priority,
            spawn_cmd: d.spawn_cmd.clone(),
            pid: None,
            last_transition: Instant::now(),
            last_will: None,
            heal_failures: 0,
        }
    }
}
