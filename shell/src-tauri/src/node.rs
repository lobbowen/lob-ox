use serde_json::Value;
use sha2::{Digest, Sha256};
use std::io::Read;
use std::path::{Path, PathBuf};

const HTTP_TOTAL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15 * 60);

fn http_get_bytes(url: &str) -> Result<Vec<u8>, String> {
    http_get_bytes_progress(url, None, None)
}

pub(crate) fn http_get_bytes_progress(
    url: &str,
    total_hint: Option<u64>,
    on_bytes: Option<&dyn Fn(u64, Option<u64>)>,
) -> Result<Vec<u8>, String> {
  
    let resp = crate::mirror::agent()
        .get(url)
        .timeout(HTTP_TOTAL_TIMEOUT)
        .call()
        .map_err(|e| format!("下载失败 {}: {}", url, e))?;
    let total = resp
        .header("content-length")
        .and_then(|v| v.trim().parse::<u64>().ok())
        .or(total_hint)
        .filter(|t| *t > 0);
    let mut buf = Vec::with_capacity(total.unwrap_or(0).min(64 * 1024 * 1024) as usize);
  
    let cap = total.map(|t| t.saturating_add(1024 * 1024)).unwrap_or(512 * 1024 * 1024);
    let mut reader = resp.into_reader();
    let mut chunk = [0u8; 64 * 1024];
    let report_every = total.map(|t| (t / 100).max(1)).unwrap_or(512 * 1024);
    let mut next_report = 0u64;
    loop {
        let n = reader.read(&mut chunk).map_err(|e| format!("读取响应失败: {}", e))?;
        if n == 0 {
            break;
        }
        buf.extend_from_slice(&chunk[..n]);
        if buf.len() as u64 > cap {
            return Err(format!(
                "下载中断 {}：响应体已超过上限 {} 字节（声称总量 {:?}）",
                url, cap, total
            ));
        }
        if let Some(cb) = on_bytes {
            let got = buf.len() as u64;
            if got >= next_report {
                next_report = got + report_every;
                cb(got, total);
            }
        }
    }
    if let Some(cb) = on_bytes {
        cb(buf.len() as u64, total);
    }
    Ok(buf)
}

fn platform_artifact(version: &str) -> Option<crate::platform::NodeArtifact> {
    crate::platform::current().node_artifact(version)
}

fn best_from_index(raw: &str) -> Option<(String, String)> {
    let idx: Value = serde_json::from_str(raw).ok()?;
    let arr = idx.as_array()?;
    let mut best: Option<(String, String)> = None;
    for item in arr {
        let lts = item.get("lts");
        let is_lts = match lts { Some(v) => !v.is_null(), None => false };
        if !is_lts { continue; }
        let ver = item.get("version").and_then(|v| v.as_str()).unwrap_or("");
        if ver.is_empty() || !ver.starts_with('v') { continue; }
        let art = match platform_artifact(&ver[1..]) { Some(a) => a, None => continue };
        let file = art.file;
        let tag = art.tag;
        let has = item.get("files").and_then(|v| v.as_array())
            .map(|a| a.iter().any(|x| x.as_str().map(|s| s == file || (s == tag)).unwrap_or(false)))
            .unwrap_or(false);
        if !has { continue; }
        // 版本比较统一走 core::semver_cmp（完整 semver，含 prerelease）。
        // 原 version_gt 只比前三段数字，会把 22.12.0-rc.1 与 22.12.0 视为相等。
        let newer = best.as_ref().map(|b| crate::core::semver_cmp(ver, &b.0) > 0).unwrap_or(true);
        if newer { best = Some((ver.to_string(), file)); }
    }
    best
}

pub struct LtsChoice {
    pub version: String,
    pub file: String,
    pub source: String,
    pub latency_ms: u128,
    pub probes: Vec<(String, bool, u128)>,
}

pub fn latest_lts() -> Result<LtsChoice, String> {
    let mirrors = crate::mirror::load();
    let probes = crate::mirror::probe_all(&mirrors.node, "index.json");
    let diag: Vec<(String, bool, u128)> = probes
        .iter()
        .map(|p| (p.source.clone(), p.ok, p.latency_ms))
        .collect();

  let mut best: Option<(String, String, u128, String)> = None; 
    for p in &probes {
        if !p.ok { continue; }
        let Some(body) = &p.body else { continue };
        let Some((ver, file)) = best_from_index(body) else { continue };
        let better = match &best {
            None => true,
            Some((bv, _, _, _)) => crate::core::semver_cmp(&ver, bv) > 0,
        };
        if better {
            best = Some((ver, file, p.latency_ms, p.source.clone()));
        }
    }
    match best {
        Some((version, file, latency_ms, source)) => {
            let mut m = crate::mirror::load();
            m.selected_node = Some(source.clone());
            if let Err(e) = crate::mirror::save(&m) {
                crate::update::log(&format!("镜像配置写入失败（不影响本次安装）: {}", e));
            }
  
            if let Err(e) = crate::mirror::export_to_kernel(&m) {
                crate::update::log(&format!("导出内核镜像偏好失败（不影响本次安装）: {}", e));
            }
            Ok(LtsChoice { version, file, source, latency_ms, probes: diag })
        }
        None => {
            let detail = probes
                .iter()
                .map(|p| {
                    if p.ok {
                        format!("{}:{}ms", p.source, p.latency_ms)
                    } else {
                        format!("{}:失败({})", p.source, p.error.as_deref().unwrap_or("无详情"))
                    }
                })
                .collect::<Vec<_>>()
                .join("; ");
            Err(format!("全部 Node 镜像均不可用或无可用 LTS（{}）", detail))
        }
    }
}

pub fn download_verified(
    version: &str,
    file: &str,
    dl_dir: &Path,
    preferred: Option<&str>,
    on_bytes: &dyn Fn(u64, Option<u64>),
) -> Result<PathBuf, String> {
    std::fs::create_dir_all(dl_dir).map_err(|e| e.to_string())?;
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
    let mut last_err: Option<String> = None;
    for base in &order {
        let base: &str = base.as_str();
        let file_url = format!("{}/{}/{}", base, version, file);
        let data = match http_get_bytes_progress(&file_url, None, Some(on_bytes)) {
            Ok(d) => d,
            Err(e) => { last_err = Some(e); continue; }
        };
        let digest = hex::encode(Sha256::digest(&data));
    
        let sums = match http_get_bytes(&format!("{}/{}/SHASUMS256.txt", base, version)) {
            Ok(bytes) => match String::from_utf8(bytes) {
                Ok(s) => s,
                Err(e) => { last_err = Some(format!("SHASUMS 读取失败: {}", e)); continue; }
            },
            Err(e) => { last_err = Some(format!("SHASUMS 下载失败: {}", e)); continue; }
        };
        let expect = match sums.lines().find_map(|l| {
            let l = l.trim();
            if l.ends_with(&format!("  {}", file)) {
                let h = l.split_whitespace().next().unwrap_or("");
                if h.len() == 64 { Some(h.to_string()) } else { None }
            } else { None }
        }) {
            Some(h) => h,
            None => { last_err = Some(format!("SHASUMS256.txt 中未找到条目 {}", file)); continue; }
        };
        if digest != expect {
            last_err = Some(format!("SHA256 校验失败：期望 {} 实得 {}（拒绝安装）", expect, digest));
            continue;
        }
        let dst = dl_dir.join(file);
        std::fs::write(&dst, &data).map_err(|e| e.to_string())?;
        return Ok(dst);
    }
    Err(last_err.unwrap_or_else(|| "下载失败".into()))
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
                crate::update::log(&format!(
                    "[runtime] Node {} 已就绪（{}）",
                    inst.version,
                    inst.bin_dir.display()
                ));
                Some(rt)
            }
            Err(e) => {
                crate::update::log(&format!("[runtime] 契约落盘失败: {}", e));
                None
            }
        },
        Err(e) => {
            crate::update::log(&format!("[runtime] 自动获取 Node 失败: {}", e));
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

pub fn npm_manual_hint(version: &str) -> String {
    format!(
        "Node.js {} 已安装，但配套的 npm（{}）仍不可用。请手动安装 Node 官方分发包（自带 npm）后重试：\
         https://nodejs.org/dist/{}/ ；若本机 Node 为裁剪分发/解包不完整，请删除其安装目录后重新运行本安装。",
        version,
        crate::platform::current().npm_exe_name(),
        version
    )
}

