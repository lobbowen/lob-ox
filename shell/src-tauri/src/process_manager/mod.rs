pub mod port_authority;
pub mod state_machine;
pub mod supervisor;
pub mod mgmt;

use std::sync::Mutex;
use std::collections::HashMap;
use std::time::Instant;

pub struct ProcessManager {
    
    pub states: Mutex<HashMap<String, state_machine::WorkloadState>>,
    
    pub ports: Mutex<port_authority::PortAuthority>,
    
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

    
    
    pub fn register_workload(&self, desc: state_machine::WorkloadDesc) {
        let mut s = self.states.lock().unwrap();
        s.entry(desc.id.clone()).or_insert_with(|| state_machine::WorkloadState::from_desc(&desc));
    }

    
    pub fn set_desired(&self, id: &str, desired: state_machine::Desired) {
        let mut s = self.states.lock().unwrap();
        if let Some(st) = s.get_mut(id) { st.desired = desired; }
    }

    
    pub fn request_restart(&self, id: &str) {
        let mut s = self.states.lock().unwrap();
        if let Some(st) = s.get_mut(id) { st.pending_restart = true; }
    }

    
    pub fn on_phase(&self, id: &str, phase: state_machine::Phase) {
        let mut s = self.states.lock().unwrap();
        if let Some(st) = s.get_mut(id) {
            st.phase = phase;
            st.last_transition = Instant::now();
            
            
            
            if matches!(phase, state_machine::Phase::Running) {
                st.fail_count = 0;
                st.window_start = None;
                st.restart_backoff = state_machine::RestartBackoff::None;
            }
        }
    }

    
    
    
    
    pub fn record_exit(&self, id: &str, last_will: state_machine::LastWill, startup_failure: bool) {
        let mut s = self.states.lock().unwrap();
        if let Some(st) = s.get_mut(id) {
            st.last_will = Some(last_will);
            let now = Instant::now();
            
            let fresh = match st.window_start {
                None => true,
                Some(t) => now.duration_since(t).as_millis() as u64 > st.restart_window_ms,
            };
            if fresh {
                st.window_start = Some(now);
                st.fail_count = 0;
            }
            
            
            
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

