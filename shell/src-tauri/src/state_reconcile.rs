use std::path::PathBuf;

pub const STAMP_FILE: &str = "state-stamp.json";

pub const SCHEMA: u32 = 1;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    
    Unchanged,
    
    Rewritten(String),
    
    Skipped(String),
}

impl Outcome {
    pub fn note(&self) -> &str {
        match self {
            Outcome::Unchanged => "未变",
            Outcome::Rewritten(s) => s.as_str(),
            Outcome::Skipped(s) => s.as_str(),
        }
    }
}

pub fn stamp_file() -> PathBuf {
    crate::env::supervisor_dir().join(STAMP_FILE)
}

pub fn read_stamp() -> Option<serde_json::Value> {
    let s = std::fs::read_to_string(stamp_file()).ok()?;
    let v: serde_json::Value = serde_json::from_str(&s).ok()?;
    if v.get("schema").and_then(|x| x.as_u64()) != Some(SCHEMA as u64) {
        return None;
    }
    Some(v)
}

pub fn write_stamp(shell_version: &str) -> Result<(), String> {
    let p = stamp_file();
    if let Some(d) = p.parent() {
        std::fs::create_dir_all(d).map_err(|e| format!("创建状态目录失败: {}", e))?;
    }
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let v = serde_json::json!({
        "schema": SCHEMA,
        "shellVersion": shell_version,
        "at": secs,
    });
    let text = serde_json::to_string_pretty(&v).map_err(|e| format!("序列化版本戳失败: {}", e))?;
    
    let tmp = p.with_extension("json.tmp");
    std::fs::write(&tmp, text).map_err(|e| format!("写版本戳失败: {}", e))?;
    std::fs::rename(&tmp, &p).map_err(|e| format!("版本戳落盘失败: {}", e))?;
    Ok(())
}

pub fn needs_reconcile(shell_version: &str) -> bool {
    match read_stamp() {
        None => true,
        Some(v) => v.get("shellVersion").and_then(|x| x.as_str()) != Some(shell_version),
    }
}

pub fn reconcile_api_port() -> Outcome {
    let cur = crate::env::api_base_url();
    let port = crate::env::api_port();
    if !crate::env::is_deprecated_api_port(port) {
        return Outcome::Unchanged;
    }
    Outcome::Skipped(format!(
        "检测到弃用端口 {}（面板地址 {}）：config.json 由内核重写，壳侧读取时已迁移；若需落盘修正请重启守卫",
        port, cur
    ))
}

pub fn reconcile_runtime_node() -> Outcome {
    let p = crate::runtime_contract::path();
    let Ok(s) = std::fs::read_to_string(&p) else {
        return Outcome::Skipped("runtime.json 不存在（尚未安装），无需对账".to_string());
    };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&s) else {
        return Outcome::Skipped("runtime.json 无法解析，需重新安装运行环境".to_string());
    };
    let Some(node) = v.get("nodePath").and_then(|x| x.as_str()) else {
        return Outcome::Skipped("runtime.json 缺 nodePath，需重新安装运行环境".to_string());
    };
    if std::path::Path::new(node).is_file() {
        return Outcome::Unchanged;
    }
    Outcome::Skipped(format!(
        "runtime.json 指向的 node 已不存在（{}）：由引导页重新探测（不在此处猜测新路径）",
        node
    ))
}

pub fn reconcile_once(shell_version: &str) -> Vec<(&'static str, Outcome)> {
    let mut out: Vec<(&'static str, Outcome)> = Vec::new();
    if !needs_reconcile(shell_version) {
        return out;
    }
    crate::update::log(&format!(
        "[state-reconcile] 版本戳变化（当前 {}）→ 开始对账状态根",
        shell_version
    ));
    let entries: Vec<(&'static str, fn() -> Outcome)> = vec![
        ("api-port", reconcile_api_port),
        ("runtime-node", reconcile_runtime_node),
        ("node-layout", reconcile_node_layout),
    ];
    for (name, f) in entries {
        let o = f();
        crate::update::log(&format!("[state-reconcile] {}: {}", name, o.note()));
        out.push((name, o));
    }
    match write_stamp(shell_version) {
        Ok(()) => crate::update::log(&format!("[state-reconcile] 版本戳已更新为 {}", shell_version)),
        Err(e) => crate::update::log(&format!("[state-reconcile] 版本戳写入失败（下轮将重试）：{}", e)),
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

        
        
        
    static STAMP_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn lock_stamp() -> std::sync::MutexGuard<'static, ()> {
        STAMP_LOCK.lock().unwrap_or_else(|e| e.into_inner())
    }

    
    #[test]
    fn s1_stamp_gates_reconciliation() {
        let _g = lock_stamp();
        
        let _ = std::fs::remove_file(stamp_file());
        assert!(needs_reconcile("1.0.3"), "S1 FAIL 无版本戳时应触发对账");
        
        write_stamp("1.0.3").expect("写版本戳");
        assert!(!needs_reconcile("1.0.3"), "S1 FAIL 同版本应跳过对账");
        
        assert!(needs_reconcile("1.0.4"), "S1 FAIL 版本变化应触发对账");
        let _ = std::fs::remove_file(stamp_file());
    }

    
    #[test]
    fn s2_schema_mismatch_forces_reconcile() {
        let _g = lock_stamp();
        let _ = std::fs::remove_file(stamp_file());
        write_stamp("1.0.3").expect("写版本戳");
        
        let mut v: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(stamp_file()).unwrap(),
        )
        .unwrap();
        v["schema"] = serde_json::json!(SCHEMA + 1);
        std::fs::write(stamp_file(), serde_json::to_string(&v).unwrap()).unwrap();
        assert!(
            read_stamp().is_none(),
            "S2 FAIL schema 不等时版本戳必须作废"
        );
        assert!(needs_reconcile("1.0.3"), "S2 FAIL schema 作废后应对账");
        let _ = std::fs::remove_file(stamp_file());
    }

    
    #[test]
    fn s3_reconcile_is_total_and_non_blocking() {
        
        let _ = reconcile_runtime_node();
        let _ = reconcile_api_port();
    }
}

pub fn reconcile_node_layout() -> Outcome {
    let priv_root = crate::env::node_install_root();
    let global = crate::env::global_install_root();
    if !priv_root.is_dir() {
        return Outcome::Unchanged;
    }
    let exe = crate::platform::current().node_exe_name();
    if !priv_root.join(exe).is_file() {
        return Outcome::Unchanged;
    }
    if global.is_dir() {
        return Outcome::Skipped(format!(
            "全局目录已存在（{}），保留现状（不覆盖既有全局安装）",
            global.display()
        ));
    }
    
    if let Some(parent) = global.parent() {
        if let Err(e) = std::fs::create_dir_all(parent) {
            return Outcome::Skipped(format!("创建全局父目录失败：{}", e));
        }
    }
    if let Err(e) = std::fs::rename(&priv_root, &global) {
        return Outcome::Skipped(format!("私有 Node 迁移到全局失败：{}", e));
    }
    
    crate::core_contract::retarget_prefix(&priv_root, &global);
    crate::runtime_contract::retarget_prefix(&priv_root, &global);
    Outcome::Rewritten(format!(
        "私有 Node 已迁到全局：{} -> {}（并同步内核/运行时位置契约）",
        priv_root.display(),
        global.display()
    ))
}
