//! 机箱统一节拍：一个时钟驱动所有注册工作负载的监督（取代内核 BeatScheduler）。
//!
//! 机箱持有单一时钟；内核不再各自启 setInterval。监督只做「机制」：
//! 探测存活 → 比对期望 → 触发重启退避；业务判定由内核经 on_phase 回灌。

use std::time::Duration;

#[derive(Debug, Clone)]
pub struct Beat {
    pub name: String,
    pub every_ticks: u64,
    pub first_ticks: u64,
    pub _timeout: Duration,
}

impl Beat {
    pub fn new(name: &str, every_ticks: u64, first_ticks: u64) -> Self {
        Beat { name: name.into(), every_ticks: every_ticks.max(1), first_ticks, _timeout: Duration::from_secs(30) }
    }
}
