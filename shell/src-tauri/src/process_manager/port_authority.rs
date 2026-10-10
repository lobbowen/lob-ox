//! 全产品唯一端口权威（取代内核三套 ports 文件）。
//!
//! 三合一是结构性根因修复：此前端口真相分裂在 ports.json / ports-router.json /
//! ports-lan.json，导致「双源端口发散」（旧产品占用的端口被新产品当作可用）。
//! 机箱持有唯一账本；内核侧 PortRegistry 改为本权威的「客户端」，调用签名不变。

use std::collections::HashMap;
use serde_json;

#[derive(Debug, Clone)]
struct Record { port: u16, role: String, owner: String }

pub struct PortAuthority {
    /// 唯一端口账本（落盘为单一 ports.json，由机箱写入，内核只读客户端）。
    records: HashMap<u16, Record>,
    /// 动态保留池（防实例端口抢占系统端口），由机箱从 config 载入。
    reserved: Vec<(u16, u16)>,
}

impl PortAuthority {
    pub fn new() -> Self {
        PortAuthority { records: HashMap::new(), reserved: vec![(49000, 49999), (43100, 43200)] }
    }

    fn reserved_of(&self, port: u16) -> bool {
        self.reserved.iter().any(|(a, b)| port >= *a && port <= *b)
    }

    /// 登记固定端口（如 dsh-main / supervisor-api）。
    pub fn register(&mut self, role: &str, port: u16) -> Result<(), String> {
        if port == 0 { return Err(format!("非法端口 {}", port)); }
        self.records.insert(port, Record { port, role: role.into(), owner: format!("system:{}", role) });
        Ok(())
    }

    ///  Sole 登记：同 role 只保留一个端口（如 supervisor-api）。
    pub fn register_sole(&mut self, role: &str, port: u16) -> Result<(), String> {
        let old: Vec<u16> = self.records.iter()
            .filter(|(_, r)| r.role == role)
            .map(|(p, _)| *p).collect();
        for p in old { self.records.remove(&p); }
        self.register(role, port)
    }

    /// 分配动态端口（实例 / 供应商端点），避开已占与保留池。
    pub fn allocate(&mut self, role: &str, owner: &str) -> Result<u16, String> {
        for p in 49000..50000u16 {
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

    /// 序列化（机箱真相的可读形态）。
    pub fn to_json(&self) -> serde_json::Value {
        serde_json::json!({ "schema": "port-authority@1", "records": self.records.values().map(|r| serde_json::json!({"port": r.port, "role": r.role, "owner": r.owner})).collect::<Vec<_>>() })
    }

    /// 落盘：机箱写入、内核只读（单向）。
    ///
    /// 刻意写**独立文件名** port-authority.json，不与内核 PortRegistry 的 ports.json 双写：
    ///   内核那份记的是它自己编排的实例端口（业务账本），机箱这份是固定角色与管理端点（框架账本），
    ///   两者角色不同；合成一份只会互相覆盖，反而制造「同一事实两套答案」。
    /// 范式同 mirror::export_to_kernel：tmp → rename 原子提交。
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
        serde_json::json!({ "schema": "port-authority@1", "records": self.records.values().map(|r| serde_json::json!({"port": r.port, "role": r.role, "owner": r.owner})).collect::<Vec<_>>() })
    }
}
