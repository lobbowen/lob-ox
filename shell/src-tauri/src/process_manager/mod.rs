//! 进程管理器机箱（底座能力，Rust）。
//!
//! 架构定位（Y 模式）：壳是底座（插座），内核是插在底座上的模块。
//! 生命周期的「大框架」——相位状态机 / 端口权威 / 自愈优先级 / 崩溃 last-will ——
//! 全部归底座所有，不随内核（常更新模块）变化。内核只持有易变业务编排，
//! 并以「意图」下发给机箱执行，机箱回灌相位 / 事件。
//!
//! 进程所有权唯一：壳拉起内核并持有其句柄，登记进本表；自愈由本表按优先级驱动。
//! 本表是全产品唯一进程真相源，内核侧对应实现一律降级为「客户端」。

pub mod port_authority;
pub mod state_machine;
pub mod mgmt;

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Instant;

/// 单一进程管理器实例（全局单例，由 main 在启动时持有）。
/// 自愈节拍间隔（秒）：内核 120s 预算下 5s 一拍足够密集，又不至于空转。
const HEAL_TICK_SECS: u64 = 5;

pub struct ProcessManager {
    /// 全产品唯一相位真相（内核 + 内核子负载）。
    pub states: Mutex<HashMap<String, state_machine::WorkloadState>>,
    /// 全产品唯一端口权威。
    pub ports: Mutex<port_authority::PortAuthority>,
}

impl ProcessManager {
    pub fn new() -> Self {
        ProcessManager {
            states: Mutex::new(HashMap::new()),
            ports: Mutex::new(port_authority::PortAuthority::new()),
        }
    }

    /// 内核向机箱注册一个工作负载（描述子只含「机制」：spawn 命令与自愈优先级）。
    /// 业务判定（令牌捕获 / 就绪 / adopt / 端口重定向）仍在内核，机箱不越界。
    pub fn register_workload(&self, desc: state_machine::WorkloadDesc) {
        let mut s = self.states.lock().unwrap();
        s.entry(desc.id.clone())
            .or_insert_with(|| state_machine::WorkloadState::from_desc(&desc));
    }

    /// 壳自持路径：壳自己拉起内核并把句柄与 pid 登记进表（进程所有权归壳）。
    /// 与 register_workload 的区别：后者是内核自报（壳不持有句柄），本方法是壳持有。
    pub fn adopt_spawned(&self, desc: state_machine::WorkloadDesc, pid: u32) {
        let mut s = self.states.lock().unwrap();
        let st = s
            .entry(desc.id.clone())
            .or_insert_with(|| state_machine::WorkloadState::from_desc(&desc));
        st.pid = Some(pid);
        st.spawn_cmd = desc.spawn_cmd.clone();
        st.priority = desc.priority;
        st.phase = state_machine::Phase::Starting;
        st.last_transition = Instant::now();
    }

    /// 内核下发意图：设定期望相位（running/stopped）。
    pub fn set_desired(&self, id: &str, desired: state_machine::Desired) {
        let mut s = self.states.lock().unwrap();
        if let Some(st) = s.get_mut(id) {
            st.desired = desired;
        }
    }

    /// 机箱 → 内核回灌：相位变更事件。
    pub fn on_phase(&self, id: &str, phase: state_machine::Phase) {
        let mut s = self.states.lock().unwrap();
        if let Some(st) = s.get_mut(id) {
            st.phase = phase;
            st.last_transition = Instant::now();
            if phase == state_machine::Phase::Running {
                st.heal_failures = 0;
            }
        }
    }

    /// 崩溃 last-will：子进程退出时记录退出码 / 信号，供引导页「为何崩」展示。
    pub fn record_exit(&self, id: &str, last_will: state_machine::LastWill) {
        let mut s = self.states.lock().unwrap();
        if let Some(st) = s.get_mut(id) {
            st.last_will = Some(last_will);
        }
    }

    /// 自愈选路：按优先级升序（内核最优先）挑出「期望 running 但当前 failed 且未耗尽重试」的对象。
    /// 返回供调用方执行重新拉起；本方法只做选择，不自行 spawn（保持机箱可测）。
    pub fn heal_candidates(&self) -> Vec<state_machine::WorkloadDesc> {
        let s = self.states.lock().unwrap();
        let mut v: Vec<&state_machine::WorkloadState> = s
            .values()
            .filter(|st| {
                st.desired == state_machine::Desired::Running
                    && st.phase == state_machine::Phase::Failed
                    && st.heal_failures < st.priority.heal_burst()
            })
            .collect();
        v.sort_by_key(|st| st.priority);
        v.into_iter()
            .map(|st| state_machine::WorkloadDesc {
                id: st.id.clone(),
                spawn_cmd: st.spawn_cmd.clone(),
                priority: st.priority,
            })
            .collect()
    }

    /// 自愈记一次失败：达到预算则停手（等人工），否则计数 +1。
    pub fn note_heal_failure(&self, id: &str) {
        let mut s = self.states.lock().unwrap();
        if let Some(st) = s.get_mut(id) {
            st.heal_failures += 1;
            st.last_transition = Instant::now();
        }
    }
}


/// 自愈节拍：壳侧唯一时钟，按优先级驱动所有已登记负载的重新拉起。
/// 这是「自愈」真正生效的位置 —— heal_candidates 只做选择，本函数负责周期执行。
/// 只重拉「壳持有 spawn_cmd 且期望 running」的对象（内核由壳 spawn 时已写入）。
pub fn spawn_healer(pm: std::sync::Arc<ProcessManager>) {
    std::thread::spawn(move || {
        loop {
            std::thread::sleep(std::time::Duration::from_secs(HEAL_TICK_SECS));
            let cands = pm.heal_candidates();
            for desc in cands {
                if desc.spawn_cmd.is_empty() {
                    continue;
                }
                let mut cmd = std::process::Command::new(&desc.spawn_cmd[0]);
                for a in desc.spawn_cmd.iter().skip(1) {
                    cmd.arg(a);
                }
                match cmd.spawn() {
                    Ok(child) => {
                        crate::update::log(&format!(
                            "[heal] 重拉 {} (pid={}, 优先级={:?})",
                            desc.id,
                            child.id(),
                            desc.priority
                        ));
                        pm.adopt_spawned(desc, child.id());
                    }
                    Err(e) => {
                        crate::update::log(&format!("[heal] 重拉 {} 失败: {}", desc.id, e));
                        pm.note_heal_failure(&desc.id);
                    }
                }
            }
        }
    });
}

impl Default for ProcessManager {
    fn default() -> Self {
        Self::new()
    }
}
