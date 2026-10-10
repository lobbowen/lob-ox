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
