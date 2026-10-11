use std::sync::Arc;
use std::time::Duration;

use crate::process_manager::state_machine;
use crate::process_manager::ProcessManager;

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

pub const TICK_MS: u64 = 5000;

fn mark(st: &mut state_machine::WorkloadState, p: state_machine::Phase) {
    st.phase = p;
    st.last_transition = std::time::Instant::now();
}

fn tick(state: &Arc<ProcessManager>) {
    let mut due: Vec<String> = Vec::new();
    {
        let mut s = match state.states.lock() {
            Ok(v) => v,
            Err(_) => return,
        };
        for (id, st) in s.iter_mut() {
            if !st.pending_restart {
                continue;
            }
            if matches!(st.restart_backoff, state_machine::RestartBackoff::Tripped) {
                st.pending_restart = false;
                continue;
            }
            if matches!(st.desired, state_machine::Desired::Stopped) {
                st.pending_restart = false;
                continue;
            }
            st.pending_restart = false;
            mark(st, state_machine::Phase::Starting);
            due.push(id.clone());
        }
    }
    for id in due {
        spawn_supervised(id, Arc::clone(state));
    }
}

fn spawn_supervised(id: String, state: Arc<ProcessManager>) {
    let spec = match crate::domain::guardctl::resolve_local(None)
        .and_then(|(rt, guard)| crate::platform::LaunchSpec::from_runtime(&rt, guard).ok())
    {
        Some(s) => s,
        None => {
            crate::update::log(&format!("[supervisor] {} 拉起失败：无法解析 node/内核守卫", id));
            if let Ok(mut s) = state.states.lock() {
                if let Some(st) = s.get_mut(&id) {
                    mark(st, state_machine::Phase::Failed);
                }
            }
            return;
        }
    };
    tokio::task::spawn_blocking(move || {
        let r = crate::platform::exec_guard(&spec);
        match r {
            Ok(()) => crate::update::log(&format!("[supervisor] {} 守卫子进程正常退出", id)),
            Err(e) => crate::update::log(&format!("[supervisor] {} 守卫子进程异常: {}", id, e)),
        }
        if let Ok(mut s) = state.states.lock() {
            if let Some(st) = s.get_mut(&id) {
                mark(st, state_machine::Phase::Stopped);
            }
        }
    });
}

pub async fn drive(state: Arc<ProcessManager>) {
    loop {
        tick(&state);
        tokio::time::sleep(Duration::from_millis(TICK_MS)).await;
    }
}