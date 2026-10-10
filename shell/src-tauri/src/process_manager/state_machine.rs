use std::time::Instant;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Phase { Stopped, Starting, Running, Draining, Failed, Restarting }

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Desired { Running, Stopped }

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RestartBackoff { None, Tripped }

#[derive(Debug, Clone)]
pub struct LastWill {
    pub code: Option<i32>,
    pub signal: Option<String>,
    pub at: Instant,
}

#[derive(Debug, Clone)]
pub struct WorkloadDesc {
    pub id: String,
    
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
