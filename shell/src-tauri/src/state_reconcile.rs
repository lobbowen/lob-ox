//! 状态根调和（State Reconciliation）。
//!
//! ## 为什么存在
//! 在线更新 = 换二进制 + 重启，**状态根不动** => 旧版写入的"事实"会一直活到出事。
//! 实证：config.json 的 apiPort=36360 跨 1.0.0/1.0.1/1.0.2 三个版本从未更新，
//! 而 36360 被老产品守卫常驻占用 => 新产品守卫永远命中「在服役·跳过启动」。
//!
//! ## 为什么不写"迁移脚本"
//! 按版本号分叉的 if-else 链是新的工程债务：每发一版都要记得加一支，漏了就静默腐烂。
//! 故采用**声明式对账**：每个易变条目给出"此刻应有的值"，与已落盘值比对，不一致则重写。
//! 它不关心"从哪个版本来"，只看"此刻对不对" => 天生幂等。
//!
//! 样板（已真机验证）：platform::windows::ensure_defined —— 期望动作 vs 记录动作，不一致即重建。
//!
//! ## 边界
//! - 不迁移用户数据（偏好 / 令牌 / 日志 / install-id）
//! - 不猜测语义：只重算"由当前代码可确定性推导"的条目
//! - 不阻断启动：单项失败记录并继续，但必须留痕

use std::path::PathBuf;

/// 版本戳文件：记"最后一次写入本状态根的壳版本 + schema"。
pub const STAMP_FILE: &str = "state-stamp.json";

/// 版本戳 schema：字段形状变了即整份作废，重新对账（与 shell_report::SCHEMA 同纪律）。
pub const SCHEMA: u32 = 1;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    /// 已落盘值与应有值一致，未改动。
    Unchanged,
    /// 已重写（携带说明，进壳日志）。
    Rewritten(String),
    /// 需人裁决或前置条件不足，未改（携带原因）。
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

/// 读版本戳。缺文件 / 解析失败 / schema 不等 => 视为"需要对账"（返回 None）。
/// 与 shell_report 的握手纪律一致：**不等即整份作废**，不猜。
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
    // 先写临时文件再改名：对账中途崩溃不得留下半截版本戳（否则下轮会误判"已对账"）。
    let tmp = p.with_extension("json.tmp");
    std::fs::write(&tmp, text).map_err(|e| format!("写版本戳失败: {}", e))?;
    std::fs::rename(&tmp, &p).map_err(|e| format!("版本戳落盘失败: {}", e))?;
    Ok(())
}


/// 是否需要对账：版本戳缺失或壳版本变化。
pub fn needs_reconcile(shell_version: &str) -> bool {
    match read_stamp() {
        None => true,
        Some(v) => v.get("shellVersion").and_then(|x| x.as_str()) != Some(shell_version),
    }
}
/// 对账条目①：API 端口。
///
/// 实证故障：config.json 的 apiPort 由内核在首次启动时落盘，此后**跨版本不再更新**；
/// 而 api_base_url 的优先级是 config.json > 常量 ⇒ 仅改常量对存量用户无效。
/// 故对账必须**改写已落盘的弃用端口**，而不是只在读取时兜一次（那是补丁）。
/// 壳只读 config.json，改由内核执行；此处负责判定并回报"需要改"。
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

/// 对账条目②：runtime 绑定的 Node 落点（私有 -> 全局）。
///
/// 实证：老布局把 Node 装在 <状态根>/node；全局化后应装到用户级全局目录。
/// 已装用户的 runtime.json 仍指向私有目录 —— 那是**合法**的既有事实（不强搬），
/// 但若指向的 node 已不存在，则必须重新解析，否则守卫永远拉不起来。
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

/// 对账一轮。幂等：版本戳未变则整轮跳过（热路径零成本）。
///
/// 不阻断启动：单项失败只记录（既有约定），但**必须留痕** —— 不留痕的对账等于没做。
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

    /// 核心性质：版本戳相同 ⇒ 整轮跳过（热路径不做事）；版本变化 ⇒ 触发对账。
    #[test]
    fn s1_stamp_gates_reconciliation() {
        // 无版本戳 ⇒ 需要对账
        let _ = std::fs::remove_file(stamp_file());
        assert!(needs_reconcile("1.0.3"), "S1 FAIL 无版本戳时应触发对账");
        // 写入后同版本 ⇒ 不需对账
        write_stamp("1.0.3").expect("写版本戳");
        assert!(!needs_reconcile("1.0.3"), "S1 FAIL 同版本应跳过对账");
        // 版本变化 ⇒ 需要对账
        assert!(needs_reconcile("1.0.4"), "S1 FAIL 版本变化应触发对账");
        let _ = std::fs::remove_file(stamp_file());
    }

    /// schema 不等即整份作废（与 shell_report 同纪律），不得靠猜沿用。
    #[test]
    fn s2_schema_mismatch_forces_reconcile() {
        let _ = std::fs::remove_file(stamp_file());
        write_stamp("1.0.3").expect("写版本戳");
        // 手工把 schema 改成未来值 ⇒ 读不到 ⇒ 需要对账
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

    /// 对账不得抛错、不得阻断：即便 runtime.json 缺失也返回 Skipped 而非 panic。
    #[test]
    fn s3_reconcile_is_total_and_non_blocking() {
        // 不预设状态根内容：任一形态都必须有结论
        let _ = reconcile_runtime_node();
        let _ = reconcile_api_port();
    }
}
