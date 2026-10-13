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


    /// 登记一个端口。register_sole 的内部实现（先清同 role 旧记录再登记新端口）。
    /// 不是对外 API：外部只有 register_sole 一个写入口（mgmt.rs:33）。
    fn register(&mut self, role: &str, port: u16) -> Result<(), String> {
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

    /// 按角色查端口。端口权威是壳侧唯一真相，mgmt 端点凭据即由它派生，
    /// 故需要这个只读查询；此前调用方只能序列化整个表再自行解析。
    pub fn get(&self, role: &str) -> Option<u16> {
        self.records
            .iter()
            .find(|(_, r)| r.role == role)
            .map(|(p, _)| *p)
    }
    pub fn to_json(&self) -> serde_json::Value {
        serde_json::json!({ "schema": "shell-ports", "records": self.records.values().map(|r| serde_json::json!({"port": r.port, "role": r.role, "owner": r.owner})).collect::<Vec<_>>() })
    }
}