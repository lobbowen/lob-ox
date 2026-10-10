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
pub mod mgmt;

use std::sync::Mutex;
use std::collections::HashMap;
use std::time::Instant;

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
        if let Some(st) = s.get_mut(id) {
            st.phase = phase;
            st.last_transition = Instant::now();
            // 自愈：真的跑起来（Running）就清空退避记账。
            //   否则一次误计（正常重启/手动重启被计入）会永久累积，5 次即跳闸且无人复位 ⇒ 产品永久停摆。
            //   「恢复正常则清零」是退避策略必需的一半，与「失败则计数」成对。
            if matches!(phase, state_machine::Phase::Running) {
                st.fail_count = 0;
                st.window_start = None;
                st.restart_backoff = state_machine::RestartBackoff::None;
            }
        }
    }

    /// 崩溃 last-will：子进程退出时记录退出码 / 信号，供引导页「为何崩」展示。
    ///
    /// 同时执行**重启退避**（框架策略，机箱持有）：窗口内累计失败次数达 burst ⇒
    /// 相位转 Failed 且退避跳闸，停手等人工 —— 崩溃不靠循环拉起来掩盖故障。
    pub fn record_exit(&self, id: &str, last_will: state_machine::LastWill, startup_failure: bool) {
        let mut s = self.states.lock().unwrap();
        if let Some(st) = s.get_mut(id) {
            st.last_will = Some(last_will);
            let now = Instant::now();
            // 窗口过期则重新计数：一次偶发崩溃不该永久计入历史。
            let fresh = match st.window_start {
                None => true,
                Some(t) => now.duration_since(t).as_millis() as u64 > st.restart_window_ms,
            };
            if fresh {
                st.window_start = Some(now);
                st.fail_count = 0;
            }
            // 只有「启动窗口内的失败」才计入退避：活过窗口后的正常重启不计、无上限
            //   （与内核 guardian.makeBudget 的 startupFailure 语义一致，否则长期运行的实例
            //    正常重启若干次就会被误判为崩溃风暴并停手 —— 「未安装/差一步」的制造者）。
            if !startup_failure { return; }
            st.fail_count = st.fail_count.saturating_add(1);
            if st.fail_count >= st.restart_burst.max(1) {
                st.restart_backoff = state_machine::RestartBackoff::Tripped;
                st.phase = state_machine::Phase::Failed;
                st.desired = state_machine::Desired::Stopped;
                st.pending_restart = false;
                st.last_transition = now;
            }
        }
    }

    /// 人工重试（引导页「重试」）：清空退避记账并重新期望运行 —— 唯一的复位入口。
    pub fn reset_backoff(&self, id: &str) {
        let mut s = self.states.lock().unwrap();
        if let Some(st) = s.get_mut(id) {
            st.fail_count = 0;
            st.window_start = None;
            st.restart_backoff = state_machine::RestartBackoff::None;
            st.desired = state_machine::Desired::Running;
            st.pending_restart = true;
            st.last_transition = Instant::now();
        }
    }
}

impl Default for ProcessManager { fn default() -> Self { Self::new() } }

