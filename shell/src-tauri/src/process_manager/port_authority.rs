use std::collections::HashMap;
use serde_json;

#[derive(Debug, Clone)]
struct Record { port: u16, role: String, owner: String }

pub struct PortAuthority {
    records: HashMap<u16, Record>,
}

impl PortAuthority {
    pub fn new() -> Self {
        PortAuthority { records: HashMap::new() }
    }

    pub fn register(&mut self, role: &str, port: u16) -> Result<(), String> {
        if port == 0 { return Err(format!("非法端口 {}", port)); }
        self.records.insert(port, Record { port, role: role.into(), owner: format!("system:{}", role) });
        Ok(())
    }

    pub fn register_sole(&mut self, role: &str, port: u16) -> Result<(), String> {
        let old: Vec<u16> = self.records.iter()
            .filter(|(_, r)| r.role == role)
            .map(|(p, _)| *p).collect();
        for p in old { self.records.remove(&p); }
        self.register(role, port)
    }

    pub fn to_json(&self) -> serde_json::Value {
        serde_json::json!({ "schema": "shell-ports", "records": self.records.values().map(|r| serde_json::json!({"port": r.port, "role": r.role, "owner": r.owner})).collect::<Vec<_>>() })
    }
}