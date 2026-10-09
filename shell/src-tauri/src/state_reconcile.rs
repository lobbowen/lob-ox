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
/// 而 api_base_url 的优先级是 config.json > 常量 ⇒ 仅改常量对存量用户无效。更关键的是：api_base_url 在**读取时**
/// 已优先用 ports.json 的真实端口（discovered_api_port）兜掉弃用端口，所以"读"一侧早已迁好；但 config.json 里
/// 落盘的 36360 仍是真实事实——内核自检、面板断言都拿它当"应然端口"。旧实现对弃用端口只返回 Skipped：判到了却不落盘，
/// 接管永远"差一步"。故对账必须**就地改写** config.json 的 apiPort 为内核自报的真实端口（ports.json supervisor-api 最新登记）。
/// ⚠ 不能读 api_port() 来判弃用：它会经 api_base_url 的读时迁移把 36360 先变成 37360，于是永远判不到弃用值。
/// 必须直接读 config.json 的字面 apiPort，再与弃用名单比对。
pub fn reconcile_api_port() -> Outcome {
    let cfg = crate::env::supervisor_dir().join("config.json");
    let Ok(text) = std::fs::read_to_string(&cfg) else {
        return Outcome::Unchanged;
    };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else {
        return Outcome::Skipped("config.json 非法 JSON，无法对账弃用端口".to_string());
    };
    let Some(raw) = v.get("apiPort").and_then(|x| x.as_u64()) else {
        return Outcome::Unchanged;
    };
    if !crate::env::is_deprecated_api_port(raw as u16) {
        return Outcome::Unchanged;
    }
    // 接管后守卫的真实端口以 ports.json 的 supervisor-api 最新登记为准（priority 高于 config.json 常量）。
    let Some(live) = crate::env::discovered_api_port() else {
        return Outcome::Skipped(format!(
            "config.json 弃用端口 {}：但 ports.json 未登记 supervisor-api 真实端口，暂不改写（守卫重启后会重新登记）",
            raw
        ));
    };
    if (raw as u16) == live {
        return Outcome::Unchanged;
    }
    let mut v = v;
    v["apiPort"] = serde_json::json!(live);
    match crate::env::write_json_atomic(&cfg, &v) {
        Ok(()) => Outcome::Rewritten(format!(
            "弃用端口 {} 已改写为接管后的真实端口 {}（config.json 原地改写）",
            raw, live
        )),
        Err(e) => Outcome::Skipped(format!("弃用端口 {} 改写失败：{}", raw, e)),
    }
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

        /// s1/s2 都写**真实状态根**下的版本戳（`stamp_file()` 无注入点），而 cargo test 默认并行
        /// ⇒ 两个用例互相删对方的文件 = 竞态（实测：新增用例改变调度后 s2 在 darwin-x64 上偶发红）。
        /// 这里用一把静态锁把它们串行化：**测试之间**互斥，不改产品行为。
    static STAMP_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn lock_stamp() -> std::sync::MutexGuard<'static, ()> {
        STAMP_LOCK.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// 核心性质：版本戳相同 ⇒ 整轮跳过（热路径不做事）；版本变化 ⇒ 触发对账。
    #[test]
    fn s1_stamp_gates_reconciliation() {
        let _g = lock_stamp();
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
        let _g = lock_stamp();
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

    /// 接管补全回归：弃用端口必须被**实际改写**进 config.json（不再是 Skipped 占位）。
    /// 早期版本只判到弃用端口却返回 Skipped，导致接管"差一步"——config 仍是 36360、
    /// 而 ports.json 登记的是 37360 ⇒ 壳用旧端口判服役、新端口导航，面板拒绝连接。
    /// 本测试在临时 HOME 下构造该局面，跑对账后**从磁盘回读 config.json** 断言 apiPort 已变为 37360。
    #[test]
    fn s4_deprecated_api_port_is_rewritten_not_skipped() {
        let _g = lock_stamp();
        let dir = std::env::temp_dir().join(format!("dsh-s4-home-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("supervisor")).unwrap();
        // state_root() 优先读 ENV_STATE_ROOT（DSH_SUPERVISOR_HOME），故把它指到临时目录，
        // 让 supervisor_dir()/ports.json/config.json 都落在 dir 下（与 env::tests::a5 同手法）。
        let saved_home = std::env::var_os("HOME");
        let saved_ur = std::env::var_os("USERPROFILE");
        let saved_dsh = std::env::var_os(crate::brand::ENV_STATE_ROOT);
        std::env::set_var("HOME", &dir);
        std::env::set_var("USERPROFILE", &dir);
        std::env::set_var(crate::brand::ENV_STATE_ROOT, &dir);

        // config.json 写着弃用端口 36360（其余键须保留）；ports.json 登记 supervisor-api 真实端口 37360。
        std::fs::write(
            dir.join("supervisor").join("config.json"),
            serde_json::json!({ "apiPort": 36360u16, "tickIntervalMs": 5000 }).to_string(),
        ).unwrap();
        std::fs::write(
            dir.join("supervisor").join("ports.json"),
            serde_json::json!({ "records": [{ "port": 37360u16, "role": "supervisor-api", "createdAt": 1u64 }] }).to_string(),
        ).unwrap();

        let o = reconcile_api_port();

        // 断言①：结果必须是"已改写"而非 Skipped/Unchanged。
        assert!(matches!(o, Outcome::Rewritten(_)), "S4 FAIL 弃用端口未被改写，仅 {:?}", o.note());
        // 断言②（关键）：从磁盘回读，确认 apiPort 真的变成了 37360，且 tickIntervalMs 等其它键被保留。
        let cfg: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(dir.join("supervisor").join("config.json")).unwrap(),
        ).unwrap();
        assert_eq!(cfg.get("apiPort").and_then(|x| x.as_u64()), Some(37360), "S4 FAIL config.json 的 apiPort 未改写为 37360");
        assert_eq!(cfg.get("tickIntervalMs").and_then(|x| x.as_u64()), Some(5000), "S4 FAIL 其它键被覆盖：tickIntervalMs 丢失");

        // 还原环境后再清理
        match &saved_home { Some(v)=>std::env::set_var("HOME",v), None=>std::env::remove_var("HOME") }
        match &saved_ur { Some(v)=>std::env::set_var("USERPROFILE",v), None=>std::env::remove_var("USERPROFILE") }
        match &saved_dsh { Some(v)=>std::env::set_var(crate::brand::ENV_STATE_ROOT,v), None=>std::env::remove_var(crate::brand::ENV_STATE_ROOT) }
        let _ = std::fs::remove_dir_all(&dir);
    }
}

/// 对账条目③：把**私有 Node 布局**迁到用户级全局目录（产品决策：不做私有化）。
///
/// 为什么必须迁：私有化 ⇒ 工具链只有本产品自己看得见（靠运行时自造 PATH），
/// 于是每套产品各装一份 Node、彼此不通；而本产品定位就是"替用户解决环境问题"，
/// 装完必须真正在全局可用。
///
/// 为什么是"移动"而不是"重装"：私有目录里可能已装了内核（@lob-ox/core-*）与 npm，
/// 重装会丢；移动后必须同步位置契约（core.json / runtime.json），否则守卫找不到入口。
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
    // 全局目录的父级（%APPDATA%\lobox）必须先存在
    if let Some(parent) = global.parent() {
        if let Err(e) = std::fs::create_dir_all(parent) {
            return Outcome::Skipped(format!("创建全局父目录失败：{}", e));
        }
    }
    if let Err(e) = std::fs::rename(&priv_root, &global) {
        return Outcome::Skipped(format!("私有 Node 迁移到全局失败：{}", e));
    }
    // 位置契约必须跟着改：否则 core.json 仍指向已搬走的私有路径 ⇒ 守卫起不来。
    crate::core_contract::retarget_prefix(&priv_root, &global);
    crate::runtime_contract::retarget_prefix(&priv_root, &global);
    Outcome::Rewritten(format!(
        "私有 Node 已迁到全局：{} -> {}（并同步内核/运行时位置契约）",
        priv_root.display(),
        global.display()
    ))
}
