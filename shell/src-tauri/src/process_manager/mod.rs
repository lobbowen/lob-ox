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

/// 一次 heal 的选路结果：重拉描述 + 该负载最近一次退出的证据。
///
/// 必须定义在**模块层级**而非 `impl` 块内 —— Rust 不允许在 trait/impl 中定义 struct
/// （编译错误：struct is not supported in `trait`s or `impl`s），而本类型又被
/// `heal_candidates()` 的返回签名引用。
///
/// last_will 随决策一起返回：它携带 startup_failure（启动窗口内退出），
/// 是「刚崩」与「拉起即失败」的唯一分界。该字段在此真正被读，注释所述行为才成立。
#[derive(Debug, Clone)]
pub struct HealCandidate {
    pub desc: state_machine::WorkloadDesc,
    pub last_will: Option<state_machine::LastWill>,
}

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
        let mut s = self.states.lock().unwrap_or_else(|e| e.into_inner());
        s.entry(desc.id.clone())
            .or_insert_with(|| state_machine::WorkloadState::from_desc(&desc));
    }

    /// 壳自持路径：壳自己拉起内核并把句柄与 pid 登记进表（进程所有权归壳）。
    /// 与 register_workload 的区别：后者是内核自报（壳不持有句柄），本方法是壳持有。
    pub fn adopt_spawned(&self, desc: state_machine::WorkloadDesc, pid: u32) {
        let mut s = self.states.lock().unwrap_or_else(|e| e.into_inner());
        let st = s
            .entry(desc.id.clone())
            .or_insert_with(|| state_machine::WorkloadState::from_desc(&desc));
        st.pid = Some(pid);
        st.spawn_cmd = desc.spawn_cmd.clone();
        st.env = desc.env.clone();
        st.priority = desc.priority;
        st.phase = state_machine::Phase::Starting;
        st.last_transition = Instant::now();
        // 重置收敛到「重生成功」这一刻：此前只有 on_phase 收到 Running 才清零，
        // 于是成功重生后 heal_failures 仍停在预算上限，自愈被永久静默禁用，
        // 只能等负载自己再报一次 running（core 从不报）。
        st.heal_failures = 0;
        st.last_will = None;
    }

    /// 内核下发意图：设定期望相位（running/stopped）。
    pub fn set_desired(&self, id: &str, desired: state_machine::Desired) {
        let mut s = self.states.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(st) = s.get_mut(id) {
            st.desired = desired;
        }
    }

    /// 机箱 → 内核回灌：相位变更事件。
    pub fn on_phase(&self, id: &str, phase: state_machine::Phase) {
        let mut s = self.states.lock().unwrap_or_else(|e| e.into_inner());
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
        let mut s = self.states.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(st) = s.get_mut(id) {
            st.last_will = Some(last_will);
        }
    }

    /// 自愈选路：按优先级升序（内核最优先）挑出「期望 running 但确实已死、且未耗尽重试」的对象。
    /// 死活的唯一判据是 pid 实探（复用 bounded::pid_alive），不是「相位写着什么」：
    /// 慢启动的 workload 在 Starting 期间不报错，若只信相位就会被每 tick 重复 spawn。
    pub fn heal_candidates(&self) -> Vec<HealCandidate> {
        let s = self.states.lock().unwrap_or_else(|e| e.into_inner());
        let mut v: Vec<&state_machine::WorkloadState> = s
            .values()
            .filter(|st| {
                if st.desired != state_machine::Desired::Running {
                    return false;
                }
                if st.heal_failures >= st.priority.heal_burst() {
                    return false;
                }
                // 有 pid 就以实探为准：活着就不 heal。pid 未知（内核自报路径）时
                // 相位是唯一可用的判据，故只在这一支接受 Failed/Installing。
                match st.pid {
                    Some(pid) => !crate::bounded::pid_alive(pid),
                    None => st.phase == state_machine::Phase::Failed,
                }
            })
            .collect();
        v.sort_by_key(|st| st.priority);
        v.into_iter()
            .map(|st| HealCandidate {
                desc: state_machine::WorkloadDesc {
                    id: st.id.clone(),
                    spawn_cmd: st.spawn_cmd.clone(),
                    priority: st.priority,
                    env: st.env.clone(),
                },
                last_will: st.last_will.clone(),
            })
            .collect()
    }

    /// 自愈记一次失败：达到预算则停手（等人工），否则计数 +1。
    pub fn note_heal_failure(&self, id: &str) {
        let mut s = self.states.lock().unwrap_or_else(|e| e.into_inner());
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
            for cand in cands {
                let desc = cand.desc;
                if desc.spawn_cmd.is_empty() {
                    continue;
                }
                // last_will 在此被真正消费：startup_failure 的负载刚在启动窗口内退出，
                // 先落日志再重拉（它不是稳定性的证据，别让日志读成「运行一段时间后崩溃」）。
                if let Some(w) = &cand.last_will {
                    crate::telemetry::event::warn("heal.prev_exit", "process_manager", serde_json::json!({
                        "id": desc.id, "code": format!("{:?}", w.code),
                        "signal": format!("{:?}", w.signal), "startup_failure": w.startup_failure
                    }));
                }
                let mut cmd = std::process::Command::new(&desc.spawn_cmd[0]);
                for a in desc.spawn_cmd.iter().skip(1) {
                    cmd.arg(a);
                }
                // 必须过 bounded::prepare：它在 Windows 上加 CREATE_NO_WINDOW。
                // 少了这一步，每次重拉内核都会弹出一个控制台窗口 —— 而 heal 在
                // 内核起不来时会在数秒内反复重拉，于是表现为「Node 窗口无限弹出」。
                crate::bounded::prepare(&mut cmd);
                // 应用负载自带的 env 覆盖：沙箱实例靠它把 HOME/APPDATA/XDG_* 指到
                // 自己的数据目录。缺了它，heal 拉起的进程与内核拉起的进程行为不同——
                // 前者写真实用户目录，破坏数据隔离。
                for (k, v) in &desc.env {
                    cmd.env(k, v);
                }
                match cmd.spawn() {
                    Ok(child) => {
                        crate::telemetry::event::info("heal.respawned", "process_manager", serde_json::json!({
                            "id": desc.id, "pid": child.id(), "priority": format!("{:?}", desc.priority)
                        }));
                        pm.adopt_spawned(desc, child.id());
                    }
                    Err(e) => {
                        crate::telemetry::event::warn("heal.respawn_failed", "process_manager", serde_json::json!({ "id": desc.id, "error": e.to_string() }));
                        pm.note_heal_failure(&desc.id);
                    }
                }
            }
        }
    });
}

// 全局单例：壳内任意位置（托盘退出、窗口关闭、进程表维护）都需拿到同一份进程真相，
// 而 Tauri 的 app.state() 只在持有 AppHandle 时可用——退出路径上常常只剩端口号。
static PM: std::sync::OnceLock<std::sync::Arc<ProcessManager>> = std::sync::OnceLock::new();

pub fn handle() -> std::sync::Arc<ProcessManager> {
    PM.get_or_init(|| std::sync::Arc::new(ProcessManager::new())).clone()
}
impl Default for ProcessManager {
    fn default() -> Self {
        Self::new()
    }
}
