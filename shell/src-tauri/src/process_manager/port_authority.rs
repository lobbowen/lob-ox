use std::collections::HashMap;
use serde_json;

#[derive(Debug, Clone)]
struct Record { port: u16, role: String, owner: String }

pub struct PortAuthority {
    
    records: HashMap<u16, Record>,
    
    reserved: Vec<(u16, u16)>,
}

impl PortAuthority {
    pub fn new() -> Self {
        PortAuthority { records: HashMap::new(), reserved: vec![(49000, 49999), (43100, 43200)] }
    }

    fn reserved_of(&self, port: u16) -> bool {
        self.reserved.iter().any(|(a, b)| port >= *a && port <= *b)
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

    
    pub fn allocate(&mut self, role: &str, owner: &str) -> Result<u16, String> {
        for p in 20000..49000u16 {
            if self.reserved_of(p) || self.records.contains_key(&p) { continue; }
            self.records.insert(p, Record { port: p, role: role.into(), owner: owner.into() });
            return Ok(p);
        }
        Err("端口池耗尽".into())
    }

    pub fn release(&mut self, port: u16, owner: &str) -> bool {
        if let Some(r) = self.records.get(&port) {
            if r.owner != owner { return false; }
        }
        self.records.remove(&port).is_some()
    }

    pub fn is_registered(&self, port: u16) -> bool { self.records.contains_key(&port) }

    pub fn get(&self, role: &str) -> Option<u16> {
        self.records.values().filter(|r| r.role == role).map(|r| r.port).max()
    }

    
    pub fn to_json(&self) -> serde_json::Value {
        serde_json::json!({ "schema": "port-authority@1", "records": self.records.values().map(|r| serde_json::json!({"port": r.port, "role": r.role, "owner": r.owner})).collect::<Vec<_>>() })
    }

    
    
    
    
    
    
    pub fn persist(&self) {
        let path = crate::env::supervisor_dir().join("port-authority.json");
        let body = match serde_json::to_string_pretty(&self.to_json()) {
            Ok(b) => b,
            Err(e) => { eprintln!("[pm] 端口账本序列化失败: {e}"); return; }
        };
        if let Some(dir) = path.parent() {
            if let Err(e) = std::fs::create_dir_all(dir) {
                eprintln!("[pm] 端口账本目录创建失败: {e}");
                return;
            }
        }
        let tmp = path.with_extension("json.tmp");
        if let Err(e) = std::fs::write(&tmp, body + "\n") {
            eprintln!("[pm] 端口账本写入失败: {e}");
            return;
        }
        if let Err(e) = std::fs::rename(&tmp, &path) {
            eprintln!("[pm] 端口账本提交失败: {e}");
        }
    }
}
