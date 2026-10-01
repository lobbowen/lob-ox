//! 发布通道选版 —— RELEASE-CHANNEL-CONTRACT 的冻结算法在桌面壳里的唯一实现。本模块不触网：registry 元数据由调用方（core.rs）传入。优先信 dist-tag 而非 versions 全量最高（那会绕过通道控制）：rollback >（灰度机）canary > latest > versions 兜底。回退必须是显式 rollback tag ——「latest 低于全量最高」机器不可分。

use serde_json::Value;

pub const CH_ROLLBACK: &str = "rollback";
pub const CH_CANARY: &str = "canary";
pub const CH_LATEST: &str = "latest";
pub const CH_VERSIONS: &str = "versions";

// 现状：该包尚未在 @lobox 下创建 —— 未创建时拉取失败即视为不命中灰度（非致命，仅留痕）；启用灰度前须先发布它。
pub const CANARY_ALLOWLIST_PKG: &str = "@lobox/canary-allowlist";

const CFG_CANARY: &str = "canary";
const CFG_ALLOWLIST: &str = "canaryAllowlist";
const ENV_CANARY: &str = "DSH_CANARY";
const ENV_ALLOWLIST: &str = "DSH_CANARY_ALLOWLIST";
const ENV_INSTALL_ID: &str = "DSH_CANARY_ID";

/// 选版结果：目标版本 + 选择依据。`via` 只作可观测性（日志 / `--core-plan` 自检），回答「这一版从哪个通道选出来」，与版本号自身的命名（`channel_of`）是两件事：回退目标本身可能是 `-BETA.` 版本。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Selected {
    pub version: String,
    pub via: &'static str,
}

/// 取一个 **dist-tag**，且**只认合法版本字面量**。非法 tag（空串 / 占位符 / 拼错）必须当作「不存在」继续走下一步 —— 否则一个手滑的 `npm dist-tag add` 会让选版卡死或装上一个不存在的版本。
fn tag(meta: &Value, name: &str) -> Option<String> {
    let v = meta.get("dist-tags")?.get(name)?.as_str()?;
    if crate::core::is_valid_version(v) {
        Some(v.to_string())
    } else {
        None
    }
}

fn highest_version(meta: &Value) -> Option<String> {
    let obj = meta.get("versions")?.as_object()?;
    let mut best: Option<String> = None;
    for k in obj.keys() {
        if !crate::core::is_valid_version(k) {
            continue;
        }
        let better = best
            .as_deref()
            .map(|b| crate::core::semver_cmp(k, b) > 0)
            .unwrap_or(true);
        if better {
            best = Some(k.clone());
        }
    }
    best
}

/// 第 5) 步的失败信息：**必须带现场**（出现过哪些 tag、versions 有多少条），否则「什么都没有」这种结论在用户现场无从排查（绝不静默，也绝不空口）。
fn empty_error(meta: &Value) -> String {
    let tags: Vec<&str> = meta
        .get("dist-tags")
        .and_then(|x| x.as_object())
        .map(|o| o.keys().map(|s| s.as_str()).collect())
        .unwrap_or_default();
    let n = meta
        .get("versions")
        .and_then(|x| x.as_object())
        .map(|o| o.len())
        .unwrap_or(0);
    format!(
        "registry 元数据中没有任何可用版本（dist-tags=[{}]；versions 条目 {} 个且无一合法）",
        if tags.is_empty() { "无".to_string() } else { tags.join(",") },
        n
    )
}

/// 冻结算法：输入 registry 元数据与本机灰度判定，输出目标版本。五步顺序不可调换：1) `dist-tags.rollback` 合法即取；2) 灰度机且 canary 合法即取；3) latest 合法即取；4) 否则取 versions 中最高合法版本兜底；5) 皆无则明确 Err（绝不猜、绝不静默降级为「已是最新」）。`canary_machine` 由调用方判定后传入，本函数保持纯函数。
pub fn select(meta: &Value, canary_machine: bool) -> Result<Selected, String> {
    if let Some(v) = tag(meta, CH_ROLLBACK) {
        return Ok(Selected { version: v, via: CH_ROLLBACK });
    }
    if canary_machine {
        if let Some(v) = tag(meta, CH_CANARY) {
            return Ok(Selected { version: v, via: CH_CANARY });
        }
    }
    if let Some(v) = tag(meta, CH_LATEST) {
        return Ok(Selected { version: v, via: CH_LATEST });
    }
    if let Some(v) = highest_version(meta) {
        return Ok(Selected { version: v, via: CH_VERSIONS });
    }
    Err(empty_error(meta))
}


pub fn canary_in_config() -> bool {
    crate::env::config_flag(CFG_CANARY)
}

pub fn canary_in_env() -> bool {
    std::env::var(ENV_CANARY).map(|v| v.trim() == "1").unwrap_or(false)
}

pub fn local_canary_hit() -> bool {
    canary_in_config() || canary_in_env()
}

pub fn allowlist_opt_in() -> bool {
    crate::env::config_flag(CFG_ALLOWLIST)
        || std::env::var(ENV_ALLOWLIST).map(|v| v.trim() == "1").unwrap_or(false)
}

/// 内核 installId 的落盘文件（相对内核状态目录）：内核 `src/platform/install-id.js` **首次读取时生成一次**，此后只读不改。
const INSTALL_ID_FILE: &str = "install-id";

/// 名单文档的**唯一格式版本**：`schema` 不为 1 -> 整份名单作废。
const ALLOWLIST_SCHEMA: u64 = 1;

pub const MATCH_LOCAL: &str = "local";
/// 命中依据：`entries[].installId` 命中（**主依据**）；`hostnames[]` 命中（**兜底**，仅 CI/容器）。
pub const MATCH_INSTALL_ID: &str = "installId";
pub const MATCH_HOSTNAME: &str = "hostname";

/// `note` **只用于日志**（排障时能看出为什么这台机器进了灰度），它**绝不参与匹配** —— 否则一句备注就能意外放行灰度。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AllowlistHit {
    pub via: &'static str,
    pub note: Option<String>,
}

/// 读取本机 installId（内核生成并持久化，壳只读不生成）：名单登记的就是内核写下、用户从面板复制的那个 UUID，壳再生成一份就两仓不一致、名单永远匹配不上，现象是「灰度静默失效」。故无生成分支：`DSH_CANARY_ID` 优先（测试机/外部灰度显式声明），否则读 `<supervisorDir>/install-id`。
pub fn install_id() -> Option<String> {
    if let Ok(s) = std::env::var(ENV_INSTALL_ID) {
        let t = s.trim();
        if !t.is_empty() {
            return Some(t.to_string());
        }
    }
    read_install_id_file(&crate::env::supervisor_dir().join(INSTALL_ID_FILE))
}

/// 读 installId 文件（**纯函数，不碰进程环境**）：只取**第一行**并 trim：契约为「纯文本一行」，但容忍末尾换行/空白 —— 若把整份内容（含换行）拿去比较，就永远不可能等于名单里的 UUID。
fn read_install_id_file(path: &std::path::Path) -> Option<String> {
    let text = std::fs::read_to_string(path).ok()?;
    let line = text.lines().next().unwrap_or("").trim();
    if line.is_empty() {
        None
    } else {
        Some(line.to_string())
    }
}

pub fn hostnames() -> Vec<String> {
    let mut v: Vec<String> = Vec::new();
    for k in ["HOSTNAME", "COMPUTERNAME"] {
        if let Ok(s) = std::env::var(k) {
            let t = s.trim();
            if !t.is_empty() && !v.iter().any(|x| x.eq_ignore_ascii_case(t)) {
                v.push(t.to_string());
            }
        }
    }
    v
}

fn strings_in(list: Option<&Vec<Value>>, key: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let Some(list) = list else { return out };
    for it in list {
        let s = if key.is_empty() {
            it.as_str()
        } else {
            it.get(key).and_then(|x| x.as_str())
        };
        if let Some(s) = s {
            let t = s.trim();
            if !t.is_empty() {
                out.push(t.to_string());
            }
        }
    }
    out
}

/// 名单是否命中本机。只认唯一形状 `schema:1` + `entries[].installId` + `hostnames[]`，不认识的形状一律不匹配（不猜）：猜测键名要付误命中的代价。匹配先主后辅：installId 命中即返回，主机名仅在前者未命中时兜底。
pub fn allowlist_match(
    doc: &Value,
    install_id: Option<&str>,
    hostnames: &[String],
) -> Option<AllowlistHit> {
    // schema 不为 1（含缺失/类型不对）-> **忽略整份名单**（不猜）：宁可让灰度暂时不命中（可见、可修），也绝不用旧规则去解释新文档（可能误命中且不可见）。
    if doc.get("schema").and_then(|x| x.as_u64()) != Some(ALLOWLIST_SCHEMA) {
        return None;
    }

    let entries = doc.get("entries").and_then(|x| x.as_array());

    if let Some(id) = install_id.map(str::trim).filter(|s| !s.is_empty()) {
        let ids = strings_in(entries, "installId");
        if let Some(i) = ids.iter().position(|e| e.eq_ignore_ascii_case(id)) {
            let note = entries
                .and_then(|a| a.get(i))
                .and_then(|x| x.get("note"))
                .and_then(|x| x.as_str())
                .map(|s| s.to_string());
            return Some(AllowlistHit {
                via: MATCH_INSTALL_ID,
                note,
            });
        }
    }

    let listed = strings_in(doc.get("hostnames").and_then(|x| x.as_array()), "");
    if hostnames.iter().any(|h| {
        let h = h.trim();
        !h.is_empty() && listed.iter().any(|e| e.eq_ignore_ascii_case(h))
    }) {
        return Some(AllowlistHit {
            via: MATCH_HOSTNAME,
            note: None,
        });
    }

    None
}

/// 灰度判定的纯逻辑核（标识与网络由调用方注入）。短路顺序即性能约束：包内名单是一次额外网络请求。1) 本地已命中（`canary: true` / `DSH_CANARY=1`）直接判灰度不再查包；2) 未命中且未 `opt_in` 返回 None，零额外请求（绝大多数机器）；3) 只有显式候选机才读包。`Err` = 名单包读取失败，等价于未命中。
pub fn canary_machine_with<F>(
    local_hit: bool,
    opt_in: bool,
    install_id: Option<&str>,
    hostnames: &[String],
    fetch: F,
) -> Result<Option<AllowlistHit>, String>
where
    F: FnOnce(&str) -> Result<Value, String>,
{
    if local_hit {
        return Ok(Some(AllowlistHit {
            via: MATCH_LOCAL,
            note: None,
        }));
    }
    if !opt_in {
        return Ok(None);
    }
    let doc = fetch(CANARY_ALLOWLIST_PKG)?;
    Ok(allowlist_match(&doc, install_id, hostnames))
}

/// 生产入口：读取本机 installId/主机名，命中与失败都**留痕**，失败按非灰度处理。
pub fn canary_machine<F>(local_hit: bool, opt_in: bool, fetch: F) -> bool
where
    F: FnOnce(&str) -> Result<Value, String>,
{
    let id = install_id();
    // **内核尚未启动过**（install-id 文件不存在）时按**非灰度**处理并留痕，仍照常调用匹配（主机名兜底对 CI/容器有效）。这里**绝不**补生成 UUID —— 生成是内核 `install-id.js` 的职责；壳若自行生成，面板上显示的会是另一个 UUID，灰度名单永远匹配不上。
    if id.is_none() && opt_in && !local_hit {
        crate::update::log(
            "灰度名单：本机读不到 installId（内核尚未启动过？也未设 DSH_CANARY_ID），\
             本轮只能按主机名兜底匹配；壳不会自行生成 installId（那是内核 install-id.js 的职责）",
        );
    }
    match canary_machine_with(local_hit, opt_in, id.as_deref(), &hostnames(), fetch) {
        Ok(Some(hit)) => {
            crate::update::log(&format!(
                "灰度名单命中（依据={}{}）",
                hit.via,
                hit.note
                    .as_deref()
                    .map(|n| format!("；名单备注：{}", n))
                    .unwrap_or_default()
            ));
            true
        }
        Ok(None) => false,
  Err(e) => {
            crate::update::log(&format!("灰度名单包不可用（按非灰度处理）：{}", e));
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Map};

    fn meta(tags: &[(&str, &str)], versions: &[&str]) -> Value {
        let mut t = Map::new();
        for (k, v) in tags {
            t.insert((*k).to_string(), json!(v));
        }
        let mut vs = Map::new();
        for v in versions {
            vs.insert((*v).to_string(), json!({}));
        }
        json!({ "dist-tags": Value::Object(t), "versions": Value::Object(vs) })
    }

    fn sel(m: &Value, canary: bool) -> (String, &'static str) {
        let s = select(m, canary).expect("应当选出目标版本");
        (s.version, s.via)
    }


    #[test]
    fn step1_rollback_wins_over_everything() {
        let m = meta(
            &[
                ("rollback", "0.1.5-BETA.6"),
                ("canary", "0.9.9-BETA.1"),
                ("latest", "0.2.0"),
            ],
            &["0.1.5-BETA.6", "0.9.9-BETA.1", "0.2.0"],
  );
        assert_eq!(sel(&m, true), ("0.1.5-BETA.6".into(), CH_ROLLBACK));
        assert_eq!(sel(&m, false), ("0.1.5-BETA.6".into(), CH_ROLLBACK));
    }

    #[test]
  fn step1_rollback_wins_even_when_lower_than_latest() {
        let m = meta(
            &[("rollback", "0.1.4"), ("latest", "0.1.9")],
            &["0.1.4", "0.1.9"],
        );
        assert_eq!(sel(&m, false), ("0.1.4".into(), CH_ROLLBACK));
    }

    #[test]
  fn step1_invalid_rollback_falls_through() {
        let m = meta(
            &[("rollback", "not-a-version"), ("latest", "0.1.9")],
            &["0.1.9"],
        );
        assert_eq!(sel(&m, false), ("0.1.9".into(), CH_LATEST));
    }


    #[test]
    fn step2_canary_only_for_listed_machine() {
        let m = meta(
            &[("canary", "0.1.6-BETA.1"), ("latest", "0.1.5-BETA.7")],
            &["0.1.5-BETA.7", "0.1.6-BETA.1"],
        );
  assert_eq!(sel(&m, true), ("0.1.6-BETA.1".into(), CH_CANARY));
        assert_eq!(sel(&m, false), ("0.1.5-BETA.7".into(), CH_LATEST));
    }

    #[test]
    fn step2_canary_invalid_or_absent_falls_to_latest() {
        let bad = meta(
            &[("canary", "v0.1.6"), ("latest", "0.1.5")],
            &["0.1.5"],
        );
        assert_eq!(sel(&bad, true), ("0.1.5".into(), CH_LATEST));
        let absent = meta(&[("latest", "0.1.5")], &["0.1.5"]);
        assert_eq!(sel(&absent, true), ("0.1.5".into(), CH_LATEST));
    }


    #[test]
  fn step3_latest_is_trusted_even_when_versions_is_higher() {
        let m = meta(&[("latest", "0.1.5-BETA.3")], &["0.1.5-BETA.3", "1.0.0-BETA.1"]);
  assert_eq!(sel(&m, false), ("0.1.5-BETA.3".into(), CH_LATEST));
        let old_form = highest_version(&m).unwrap();
        assert_eq!(old_form, "1.0.0-BETA.1");
        assert_ne!(old_form, "0.1.5-BETA.3");
    }

    #[test]
    fn step3_latest_wins_over_versions_even_when_lower() {
        let m = meta(&[("latest", "0.1.1-BETA.1")], &["0.1.1-BETA.1", "0.1.5-BETA.7"]);
        assert_eq!(sel(&m, false), ("0.1.1-BETA.1".into(), CH_LATEST));
    }


    #[test]
    fn step4_falls_back_to_highest_version_when_latest_missing() {
        let m = meta(&[], &["0.1.5-BETA.3", "0.1.5-BETA.7", "0.1.4"]);
        assert_eq!(sel(&m, false), ("0.1.5-BETA.7".into(), CH_VERSIONS));
    }

    #[test]
    fn step4_fallback_ignores_invalid_version_keys() {
        let m = meta(&[("latest", "")], &["bad", "0.1.4", "0.1.5-BETA.1"]);
        assert_eq!(sel(&m, false), ("0.1.5-BETA.1".into(), CH_VERSIONS));
    }

    #[test]
    fn step4_no_dist_tags_at_all() {
        let m = json!({ "versions": { "0.2.0": {}, "0.1.0": {} } });
        assert_eq!(sel(&m, false), ("0.2.0".into(), CH_VERSIONS));
    }


    #[test]
  fn step5_errors_instead_of_guessing() {
        let m = meta(&[("latest", "nope"), ("canary", "")], &["x", "y"]);
        let e = select(&m, true).expect_err("应当明确报错");
        assert!(e.contains("没有任何可用版本"), "错误信息应说明原因：{}", e);
    }

    #[test]
    fn step5_empty_metadata_errors() {
        let e = select(&json!({}), false).expect_err("空元数据必须报错");
        assert!(e.contains("dist-tags=[无]"), "错误信息应带现场：{}", e);
    }

    #[test]
    fn step5_error_mentions_present_tags_for_diagnosis() {
        let m = meta(&[("next", "0.3.0")], &[]);
        let e = select(&m, false).expect_err("无可用通道必须报错");
        assert!(e.contains("next"), "错误信息应列出实际存在的 tag：{}", e);
    }


    static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

  const ID: &str = "550e8400-e29b-41d4-a716-446655440000";
    const OTHER_ID: &str = "11111111-2222-4333-8444-555555555555";

    fn allowlist(entries: Value, hostnames: Value) -> Value {
        json!({
            "schema": 1,
            "updatedAt": "2026-09-16T00:00:00Z",
            "entries": entries,
            "hostnames": hostnames,
        })
    }

    #[test]
  fn allowlist_local_hit_short_circuits_without_query() {
        let hit = canary_machine_with(true, false, None, &[], |_| {
            panic!("本机配置已命中，不得再查名单包（会多一次网络请求）")
        })
        .unwrap();
        assert_eq!(hit.map(|h| h.via), Some(MATCH_LOCAL));
    }

    #[test]
  fn allowlist_normal_machine_pays_no_extra_request() {
        let hit = canary_machine_with(false, false, Some(ID), &["my-box".into()], |_| {
            panic!("未 opt-in 的机器不得查名单包（正常用户零额外请求）")
        })
        .unwrap();
        assert!(hit.is_none());
    }

    #[test]
  fn allowlist_matches_install_id() {
        let doc = allowlist(
            json!([{ "installId": ID.to_uppercase(), "note": "张工内测机" }]),
            json!([]),
        );
        assert_eq!(
            allowlist_match(&doc, Some(ID), &[]),
            Some(AllowlistHit { via: MATCH_INSTALL_ID, note: Some("张工内测机".into()) }),
  );
        assert_eq!(allowlist_match(&doc, Some(OTHER_ID), &[]), None);
    }

    #[test]
  fn allowlist_hostname_is_fallback_hit() {
        let doc = allowlist(json!([]), json!(["build-bot-01"]));
        assert_eq!(
            allowlist_match(&doc, Some(OTHER_ID), &["Build-Bot-01".into()]),
            Some(AllowlistHit { via: MATCH_HOSTNAME, note: None }),
  );
  assert_eq!(allowlist_match(&doc, Some(OTHER_ID), &["my-box".into()]), None);
        assert_eq!(allowlist_match(&doc, None, &[]), None);
    }

    #[test]
  fn allowlist_requires_schema_1() {
        for bad in [json!(2), json!("1"), json!(null), json!(1.5)] {
            let doc = json!({
                "schema": bad,
                "entries": [{ "installId": ID }],
                "hostnames": ["build-bot-01"],
            });
            assert_eq!(
                allowlist_match(&doc, Some(ID), &["build-bot-01".into()]),
                None,
                "schema 非 1 时整份名单必须作废：{}",
                doc
            );
  }
        let no_schema = json!({ "entries": [{ "installId": ID }] });
        assert_eq!(allowlist_match(&no_schema, Some(ID), &[]), None);
    }

    #[test]
  fn allowlist_note_never_participates_in_matching() {
  let doc = allowlist(json!([{ "installId": OTHER_ID, "note": ID }]), json!([ID]));
  assert_eq!(allowlist_match(&doc, Some(ID), &[]), None);
        assert_eq!(
            allowlist_match(&doc, None, &[ID.to_string()]),
            Some(AllowlistHit { via: MATCH_HOSTNAME, note: None }),
        );
    }

    #[test]
  fn allowlist_legacy_shapes_are_rejected() {
        for legacy in [
            json!([ID, OTHER_ID]),
            json!([{ "id": ID }, { "machineId": ID }]),
            json!({ "machines": [ID] }),
            json!({ "allow": [{ "hostname": ID }] }),
            json!({ "allowlist": [ID] }),
            json!({ "ids": [ID] }),
            json!({ "id": ID }),
        ] {
            assert_eq!(
                allowlist_match(&legacy, Some(ID), &[ID.to_string()]),
                None,
                "旧形状必须被拒绝（不再猜测）：{}",
                legacy
            );
        }
    }

    #[test]
  fn allowlist_candidate_reads_package_and_matches() {
        let doc = allowlist(json!([{ "installId": ID }]), json!([]));
        assert_eq!(
            canary_machine_with(false, true, Some(ID), &[], |_| Ok(doc.clone()))
                .unwrap()
                .map(|h| h.via),
            Some(MATCH_INSTALL_ID),
        );
        let miss = allowlist(json!([{ "installId": OTHER_ID }]), json!([]));
        assert!(canary_machine_with(false, true, Some(ID), &[], |_| Ok(miss))
            .unwrap()
            .is_none());
    }

    #[test]
    fn allowlist_failure_is_reported_not_fatal() {
        let r = canary_machine_with(false, true, Some(ID), &[], |_| {
            Err("404 Not Found".to_string())
        });
        assert!(r.is_err(), "读取失败必须如实回传（由调用方按非灰度处理并留痕）");
    }


    #[test]
    fn read_install_id_file_takes_first_line_and_tolerates_whitespace() {
        let dir = std::env::temp_dir().join(format!("dsh-install-id-ut-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("install-id");

        std::fs::write(&p, format!("{}\n", ID)).unwrap();
        assert_eq!(read_install_id_file(&p).as_deref(), Some(ID));

        std::fs::write(&p, ID).unwrap();
        assert_eq!(read_install_id_file(&p).as_deref(), Some(ID));

        std::fs::write(&p, "  \n").unwrap();
        assert_eq!(read_install_id_file(&p), None);

        assert_eq!(read_install_id_file(&dir.join("nope")), None);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn install_id_env_override_wins_and_is_trimmed() {
  let _g = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        std::env::set_var(ENV_INSTALL_ID, format!("  {}  ", ID));
        assert_eq!(install_id().as_deref(), Some(ID));
        std::env::remove_var(ENV_INSTALL_ID);
    }

    #[test]
    fn canary_machine_production_entry_swallows_package_errors() {
  let _g = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        std::env::set_var(ENV_ALLOWLIST, "1");
        std::env::set_var(ENV_INSTALL_ID, "unit-box");
        let hit = canary_machine(false, true, |_| Err("404".to_string()));
        std::env::remove_var(ENV_ALLOWLIST);
        std::env::remove_var(ENV_INSTALL_ID);
        assert!(!hit);
    }
}
