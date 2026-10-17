use std::path::{Path, PathBuf};



pub struct LtsChoice {
    pub version: String,
    pub file: String,
    pub source: String,
    pub latency_ms: u128,
    pub probes: Vec<(String, bool, u128)>,
}

/// 解析上游索引，返回当前可用的最新 LTS。
///
/// 委托 runtime::node::select_latest —— LTS 判定只有一处实现。
///
/// 此前本文件另有一份 best_from_index 做同样的事，而它的 LTS 判定写成
/// `Some(v) => !v.is_null()`，**漏了 JSON false**。Node 索引里非 LTS 线（奇数大版本，
/// 如 v26）的 lts 值是 false 而非缺失，于是「最新 LTS」被选成 v26 ——
/// 真机日志：[runtime] 选用镜像 .../nodejs-release，官方最新 LTS v26.11.1，
/// 而 nodejs.org 上 v26.11.1 的 lts 确实是 false。
/// 两份判据分叉正是这轮事故的成因，故此处只保留一份。
pub fn latest_lts() -> Result<LtsChoice, String> {
    let m = crate::mirror::load();
    let probes = crate::mirror::probe_all(&m.node, crate::runtime::node::INDEX_PATH);
    let diag: Vec<(String, bool, u128)> = probes
        .iter()
        .map(|p| (p.source.clone(), p.ok, p.latency_ms))
        .collect();
    let sel = crate::runtime::node::select_latest()?;
    // 选定镜像仍写回偏好，供后续下载优先使用。
    let mut mm = crate::mirror::load();
    mm.selected_node = Some(sel.source.clone());
    if let Err(e) = crate::mirror::save(&mm) {
        crate::telemetry::event::warn("node.mirror_save_failed", "node", serde_json::json!({ "error": e.to_string() }));
    }
    if let Err(e) = crate::mirror::export_to_kernel(&mm) {
        crate::telemetry::event::warn("node.mirror_export_failed", "node", serde_json::json!({ "error": e.to_string() }));
    }
    Ok(LtsChoice {
        version: sel.version,
        file: sel.file,
        source: sel.source,
        latency_ms: sel.latency_ms,
        probes: diag,
    })
}
/// 取回 Node 官方归档并校验 SHA256。
///
/// 下载与回退交给 transfer::fetch（与内核、桌面壳同一条通路）；
/// 本函数只保留 Node 特有的两件事：SHASUMS256.txt 的摘要怎么取、以及产物落哪。
pub fn download_verified(
    version: &str,
    file: &str,
    dl_dir: &Path,
    preferred: Option<&str>,
    on_bytes: &dyn Fn(u64, Option<u64>),
) -> Result<PathBuf, String> {
    let mirrors = crate::mirror::load();
    let mut order: Vec<String> = Vec::new();
    if let Some(p) = preferred {
        if !p.is_empty() {
            order.push(p.to_string());
        }
    }
    for s in &mirrors.node {
        if !order.iter().any(|x| x == s) {
            order.push(s.clone());
        }
    }
    let dst = dl_dir.join(file);
    for base in &order {
        let base = base.as_str();
        // 摘要来自同源的 SHASUMS256.txt：与归档一起发布，取不到即视为该源不可用。
        let sums = match crate::transfer::fetch(
            &[crate::transfer::source::under(base, version, "SHASUMS256.txt")],
            &crate::transfer::Request::new(
                crate::transfer::staging_dir().join(format!("{}-SHASUMS256.txt", version)),
            )
            .timeout(std::time::Duration::from_secs(30)),
            &|_, _| {},
        ) {
            Ok(_) => std::fs::read_to_string(
                crate::transfer::staging_dir().join(format!("{}-SHASUMS256.txt", version)),
            )
            .map_err(|e| format!("{} 的 SHASUMS256.txt 读取失败: {}", base, e))?,
            Err(e) => {
                crate::telemetry::event::warn("node.shasums_unavailable", "node", serde_json::json!({ "base": base, "error": e.to_string() }));
                continue;
            }
        };
        let expect = match sums.lines().find_map(|l| {
            crate::transfer::verify::Expectation::from_shasums_line(l, file)
        }) {
            Some(e) => e,
            None => {
                crate::telemetry::event::info("node.shasums_entry_missing", "node", serde_json::json!({ "base": base, "file": file }));
                continue;
            }
        };
        let cands = vec![crate::transfer::source::under(base, version, file)];
        let req = crate::transfer::Request::new(&dst).verify(expect);
        match crate::transfer::fetch(&cands, &req, &|d, t| on_bytes(d, t)) {
            Ok(got) => {
                crate::telemetry::event::info("node.archive_fetched", "node", serde_json::json!({
                    "file": file, "bytes": got.bytes, "source": got.source
                }));
                return Ok(got.path);
            }
            Err(e) => {
                crate::telemetry::event::warn("node.archive_unavailable", "node", serde_json::json!({ "base": base, "error": e.to_string() }));
            }
        }
    }
    Err(format!("全部 {} 个 Node 源均未取得可用归档", order.len()))
}

pub fn outdated(installed: Option<&str>, latest: &str) -> bool {
    match installed {
        None => true,
        Some(v) => crate::core::semver_cmp(latest, v) > 0,
    }
}

static MIN_NODE_CELL: std::sync::OnceLock<&'static str> = std::sync::OnceLock::new();

// 真相来自 shared-constants.json。不能用 const：解析器依赖运行期字符串操作。
pub fn min_node() -> &'static str {
    MIN_NODE_CELL.get_or_init(|| crate::brand::shared_str("runtime.minNode"))
}

pub fn meets_minimum(installed: Option<&str>) -> bool {
    match installed {
        None => false,
        Some(v) => crate::core::semver_cmp(min_node(), v) <= 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn version_compare() {
        // 版本比较统一走 core::semver_cmp（node.rs 自己的 version_gt 已删）。
        assert!(crate::core::semver_cmp("v2.0.0", "v1.9.9") > 0);
        assert!(crate::core::semver_cmp("v22.25.0", "v22.24.0") > 0);
        assert!(crate::core::semver_cmp("v1.9.9", "v2.0.0") < 0);
        assert_eq!(crate::core::semver_cmp("v22.24.0", "v22.24.0"), 0);
    }

    #[test]
    fn prerelease_is_lower_than_release() {
        // 原 version_gt 丢 prerelease，会把 rc 与正式版视为相等；
        // semver_cmp 正确判定 22.12.0-rc.1 < 22.12.0。
        assert!(crate::core::semver_cmp("v22.12.0-rc.1", "v22.12.0") < 0);
    }

    #[test]
    fn outdated_logic() {
        assert!(outdated(None, "v26.8.1"));
        assert!(outdated(Some("v26.7.0"), "v26.8.1"));
        assert!(!outdated(Some("v26.8.1"), "v26.8.1"));
        assert!(!outdated(Some("v27.0.0"), "v26.8.1"));
    }
    #[test]
    fn meets_minimum_logic() {
        assert!(!meets_minimum(None));
        assert!(!meets_minimum(Some("v18.20.0")));
        assert!(!meets_minimum(Some("v21.0.0")));
        assert!(meets_minimum(Some("v22.12.0")));
        assert!(meets_minimum(Some("v22.25.0")));
        assert!(meets_minimum(Some("v26.7.0")));
        assert!(meets_minimum(Some("v27.0.0")));
    }
}

/// 静默获取一个达标的 Node：选版 → 下载校验 → 解压提交 → 落契约。
///
/// 这是 `domain::install::run_install` 的无 UI 版本：两者的下载/校验/安装/提交步骤
/// 逐步共用同一批函数（latest_lts / download_verified）；安装与落定已下沉到 runtime 底座，
/// 差别只有「是否往 UI 推 install_progress 事件」—— 自动路径没有 AppHandle 可用，
/// 故进度写日志而不是事件。
///
/// 之所以不直接复用 run_install：它整体签名要求 &tauri::AppHandle（用于 stage/push），
/// 而启动门 `runtime_contract::ensure()` 在内核拉起前调用，那时尚无 AppHandle。
/// 把「获取 Node」拆成无 UI 的本体 + 带 UI 的包装，避免为了复用而把 AppHandle
/// 一路传到启动关键路径上。
/// 开机自动获取一个可用的 Node（静默，无用户确认）。
///
/// 委托 runtime::node::install_latest —— 底座负责全部流程：
/// 选最新 LTS -> 下载校验 -> 解包 staging -> 切换到专属目录 -> 接入用户 PATH。
///
/// 与此前在此处内联实现的差别：
///   - 落点从 npm 全局 prefix 改为 %LOCALAPPDATA%/lobox/runtime/node（专属目录），
///     不再与用户所有全局 npm 包混放，也不再撞上正在运行的 node.exe；
///   - 换装走 engine::swap，旧装被占用时备份失败即报错且不删旧装；
///   - 落定后把 bin 目录接入用户级 PATH，使新终端/IDE 直接可用；
///   - 新增运行时时本函数无需改动 —— 它只认 runtime 这一个入口。
pub fn auto_install_quiet() -> Option<crate::runtime_contract::NodeRuntime> {
    match crate::runtime::node::install_latest(&crate::runtime::node::Progress::default()) {
        Ok(inst) => match crate::runtime_contract::adopt_installed(&inst) {
            Ok(rt) => {
                crate::telemetry::event::info("runtime.node_ready", "runtime", serde_json::json!({
                    "version": inst.version, "binDir": inst.bin_dir.display().to_string()
                }));
                Some(rt)
            }
            Err(e) => {
                crate::telemetry::event::warn("runtime.contract_persist_failed", "runtime", serde_json::json!({ "error": e.to_string() }));
                None
            }
        },
        Err(e) => {
            crate::telemetry::event::warn("runtime.node_acquire_failed", "runtime", serde_json::json!({ "error": e.to_string() }));
            None
        }
    }
}
pub fn probe_after() -> Option<(PathBuf, String)> {
    if let Some((p, v)) = crate::env::probe_system_node() { return Some((p, v)); }
    crate::env::known_install_node_path().and_then(|p| crate::env::node_version(&p).map(|v| (p, v)))
}

pub fn now_iso() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let (h, mi, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    let (y, m, d) = civil_from_days(days);
    format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z", y, m, d, h, mi, s)
}

fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
  let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
  let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
  let y = yoe + era * 400;
  let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
  let mp = (5 * doy + 2) / 153;
  let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

