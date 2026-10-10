use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use crate::domain::probes::{Probe, Record, Snapshot};
use crate::nodeprobe::Outcome;

pub const SCHEMA: u32 = 1;

pub const FILE_NAME: &str = "shell-report.json";

const MIN_WRITE_GAP: Duration = Duration::from_secs(10);

pub fn file() -> PathBuf {
    crate::env::supervisor_dir().join(FILE_NAME)
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn node_view(out: &Outcome) -> Option<serde_json::Value> {
    let version = out.version.as_ref()?;
    Some(serde_json::json!({
        "path": out.path.as_ref().map(|p| p.display().to_string()),
        "binDir": out.path.as_ref().and_then(|p| p.parent()).map(|d| d.display().to_string()),
        "version": version,
        "min": crate::node::MIN_NODE,
        "ok": crate::node::meets_minimum(Some(version.as_str())),
    }))
}

fn npm_view(deps: &Snapshot) -> Option<serde_json::Value> {
    let usable = deps.npm.usable.as_ref()?;
    Some(serde_json::json!({
        "path": usable.path.display().to_string(),
        "args": usable.args,
        "version": usable.version,
        "ok": deps.npm.ok(),
    }))
}

fn prefix_view(deps: &Snapshot) -> Option<serde_json::Value> {
    let r = dep_record(deps, Probe::Prefix)?;
    let why = match r.ok {
        Some(true) => serde_json::Value::Null,
        _ => serde_json::Value::String(r.note.clone()),
    };
    Some(serde_json::json!({ "dir": r.target, "writable": r.ok, "why": why }))
}

fn registry_view() -> Option<serde_json::Value> {
    let s = crate::mirror::cached()?;
    Some(serde_json::json!({
        "best": s.npm_best,
        "latencyMs": s.npm_latency_ms,
        "probes": s.npm_probes.iter().map(|(src, ok, ms)| serde_json::json!({
            "url": src, "ok": ok, "latencyMs": ms
        })).collect::<Vec<_>>(),
    }))
}

fn dep_record<'a>(deps: &'a Snapshot, probe: Probe) -> Option<&'a Record> {
    deps.records.iter().find(|r| r.probe == probe)
}

fn records(out: &Outcome, deps: &Snapshot) -> Vec<serde_json::Value> {
    let mut v: Vec<serde_json::Value> = out.records.iter().map(|r| r.json()).collect();
    v.extend(deps.records.iter().map(|r| r.json()));
    v
}

pub fn payload(out: &Outcome, deps: &Snapshot) -> serde_json::Value {
    serde_json::json!({
        "schema": SCHEMA,
        
        "writtenBy": format!("{}@{}", crate::brand::GUI_BIN_NAME, env!("CARGO_PKG_VERSION")),
        "node": node_view(out),
        "npm": npm_view(deps),
        "prefix": prefix_view(deps),
        "registry": registry_view(),
        "records": records(out, deps),
    })
}

fn due(last: Option<Duration>, gap: Duration) -> bool {
    match last {
        Some(age) => age >= gap,
        None => true,
    }
}

fn ledger() -> &'static Mutex<Option<Instant>> {
    static L: OnceLock<Mutex<Option<Instant>>> = OnceLock::new();
    L.get_or_init(|| Mutex::new(None))
}

fn post(payload: &serde_json::Value) -> Result<(), String> {
    let dir = crate::env::supervisor_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建内核状态目录失败：{}", e))?;
    let mut doc = payload
        .as_object()
        .cloned()
        .ok_or_else(|| "报告载荷不是 JSON 对象".to_string())?;
    doc.insert(String::from("at"), serde_json::json!(now_millis()));
    let body = serde_json::to_string_pretty(&serde_json::Value::Object(doc))
        .map_err(|e| format!("序列化报告失败：{}", e))?;
    let p = file();
    let tmp = p.with_extension("json.tmp");
    std::fs::write(&tmp, body + "\n").map_err(|e| format!("写入临时文件失败：{}", e))?;
    std::fs::rename(&tmp, &p).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("提交报告失败：{}", e)
    })
}

pub fn publish(out: &Outcome, deps: &Snapshot) {
    let mut g = match ledger().lock() {
        Ok(g) => g,
        Err(e) => e.into_inner(),
    };
    if !due(g.as_ref().map(|t| t.elapsed()), MIN_WRITE_GAP) {
        return;
    }
    *g = Some(Instant::now());
    drop(g);
    if let Err(why) = post(&payload(out, deps)) {
        crate::update::log(&format!("投放环境观测报告失败（内核按「壳还没报过」处理，不影响引导）：{}", why));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::probes::NpmFact;
    use crate::runtime_contract::NpmUsable;
    use std::path::PathBuf;

    fn outcome(path: Option<&str>, version: Option<&str>) -> Outcome {
        Outcome {
            path: path.map(PathBuf::from),
            version: version.map(String::from),
            records: vec![Record::new(Probe::Node, "PATH", "/opt/node/bin/node".into(), 12, Some(true), "v22.12.0")],
            elapsed_ms: 12,
            finished: true,
            error: None,
        }
    }

    fn prefix_record(ok: Option<bool>, note: &str) -> Record {
        Record::new(Probe::Prefix, "npm prefix -g", "/usr/local".into(), 5, ok, note)
    }

    fn deps(usable: Option<NpmUsable>, prefix: Record) -> Snapshot {
        let why = if usable.is_some() { None } else { Some("本轮未探测到 node".to_string()) };
        Snapshot { records: vec![prefix], npm: NpmFact { node_seen: usable.is_some(), usable, why } }
    }

        
    #[test]
    fn payload_carries_the_contract_keys() {
        let u = NpmUsable { path: PathBuf::from("/opt/node/bin/npm"), args: vec![], version: "10.9.2".into() };
        let j = payload(&outcome(Some("/opt/node/bin/node"), Some("v22.12.0")), &deps(Some(u), prefix_record(Some(true), "目录可写")));
        assert_eq!(j["schema"], serde_json::json!(SCHEMA));
        for k in ["writtenBy", "node", "npm", "prefix", "registry", "records"] {
            assert!(j.get(k).is_some(), "载荷缺契约键 {}", k);
        }
        assert_eq!(j["node"]["version"], "v22.12.0");
        assert_eq!(j["node"]["min"], crate::node::MIN_NODE);
        assert_eq!(j["npm"]["path"], "/opt/node/bin/npm");
        assert_eq!(j["npm"]["args"], serde_json::json!([]));
        assert_eq!(j["prefix"]["dir"], "/usr/local");
        assert_eq!(j["records"][0]["probe"], "node", "记录形态必须出自 Record::json");
        assert_eq!(j["records"][1]["probe"], "prefix");
    }

    #[test]
    fn unknown_is_not_collapsed_into_failure() {
        let pending = prefix_view(&deps(None, prefix_record(None, "npm 未通过可用性探针"))).expect("有记录必须有视图");
        assert_eq!(pending["writable"], serde_json::Value::Null, "无从判定不得报成失败");
        assert_eq!(pending["why"], "npm 未通过可用性探针");
        let ok = prefix_view(&deps(None, prefix_record(Some(true), "目录可写"))).expect("有记录必须有视图");
        assert_eq!(ok["writable"], serde_json::json!(true));
        assert_eq!(ok["why"], serde_json::Value::Null);
    }

    #[test]
    fn absent_node_yields_no_views() {
        let out = outcome(None, None);
        assert!(node_view(&out).is_none(), "没探到版本就不能有 node 视图");
        assert!(npm_view(&deps(None, prefix_record(None, "无从判定"))).is_none());
        let j = payload(&out, &deps(None, prefix_record(None, "无从判定")));
        assert_eq!(j["node"], serde_json::Value::Null);
        assert!(j["records"].as_array().expect("records 必须是数组").len() >= 2, "探测记录必须原样带上，排障靠它");
    }

    #[test]
    fn write_floor_judgement_is_exhaustive() {
        let gap = Duration::from_secs(10);
        assert!(due(None, gap), "从没投过就必须投一次，否则内核永远看到「没报过」");
        assert!(due(Some(Duration::from_secs(11)), gap));
        assert!(!due(Some(Duration::from_millis(9999)), gap));
        assert!(due(Some(gap), gap), "到界必须投");
    }
}
