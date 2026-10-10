//! 进程管理器机箱（底座能力，Rust）。
//!
//! 架构定位（Y 模式）：壳是底座（插座），内核是插在底座上的模块。
//! 生命周期的「大框架」——相位状态机 / 端口权威 / 重启退避 / 统一节拍 / 崩溃 last-will ——
//! 全部归底座所有，不随内核（常更新模块）变化。内核只持有易变业务编排，
//! 并以「意图」下发给机箱执行，机箱回灌相位 / 事件。
//!
//! 这是结构性收口：此前这些职责分散在内核 BeatScheduler / ManagedRegistry /
//! PortRegistry / guardian 等多处，并与壳监督内核的 watchdog 形成双向监督环。
//! 本模块成为唯一真相源；内核侧对应实现一律降级为「客户端」，签名不变、零胶水。

pub mod port_authority;
pub mod state_machine;
pub mod supervisor;

use std::sync::{Mutex, Arc};
use std::collections::HashMap;
use std::time::{Instant, Duration};

/// 单一进程管理器实例（全局单例，由 main 在启动时持有）。
pub struct ProcessManager {
    /// 全产品唯一相位真相（壳自身 + 内核模块 + 内核子负载）。
    pub states: Mutex<HashMap<String, state_machine::WorkloadState>>,
    /// 全产品唯一端口权威（取代内核 ports.json / ports-router.json / ports-lan.json 三套）。
    pub ports: Mutex<port_authority::PortAuthority>,
    /// 机箱统一节拍：一个时钟驱动所有注册工作负载的监督。
    pub beats: Mutex<Vec<supervisor::Beat>>,
}

impl ProcessManager {
    pub fn new() -> Self {
        ProcessManager {
            states: Mutex::new(HashMap::new()),
            ports: Mutex::new(port_authority::PortAuthority::new()),
            beats: Mutex::new(Vec::new()),
        }
    }

    /// 内核向机箱注册一个工作负载（描述子只含「机制」：spawn 命令、重启策略、期望数）。
    /// 业务判定（令牌捕获 / 就绪 / adopt / 端口重定向）仍在内核，机箱不越界。
    pub fn register_workload(&self, desc: state_machine::WorkloadDesc) {
        let mut s = self.states.lock().unwrap();
        s.entry(desc.id.clone()).or_insert_with(|| state_machine::WorkloadState::from_desc(&desc));
    }

    /// 内核下发意图：设定期望相位（running/stopped）。
    pub fn set_desired(&self, id: &str, desired: state_machine::Desired) {
        let mut s = self.states.lock().unwrap();
        if let Some(st) = s.get_mut(id) { st.desired = desired; }
    }

    /// 内核主动重启请求（用户意图，非崩溃复活）：转交机箱执行。
    pub fn request_restart(&self, id: &str) {
        let mut s = self.states.lock().unwrap();
        if let Some(st) = s.get_mut(id) { st.pending_restart = true; }
    }

    /// 机箱 → 内核回灌：相位变更事件。
    pub fn on_phase(&self, id: &str, phase: state_machine::Phase) {
        let mut s = self.states.lock().unwrap();
        if let Some(st) = s.get_mut(id) { st.phase = phase; st.last_transition = Instant::now(); }
    }

    /// 崩溃 last-will：子进程退出时记录退出码 / 信号，供引导页「为何崩」展示。
    pub fn record_exit(&self, id: &str, last_will: state_machine::LastWill) {
        let mut s = self.states.lock().unwrap();
        if let Some(st) = s.get_mut(id) { st.last_will = Some(last_will); }
    }
}

impl Default for ProcessManager { fn default() -> Self { Self::new() } }

