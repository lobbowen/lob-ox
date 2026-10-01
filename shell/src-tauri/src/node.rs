use serde_json::Value;
use sha2::{Digest, Sha256};
use std::io::Read;
use std::path::{Path, PathBuf};

// 镜像候选来自 mirror.rs 的 NODE_PRESETS（壳自持配置，支持用户自定义）。

const HTTP_TOTAL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15 * 60);

fn http_get_bytes(url: &str) -> Result<Vec<u8>, String> {
    http_get_bytes_progress(url, None, None)
}

pub(crate) fn http_get_bytes_progress(
    url: &str,
    total_hint: Option<u64>,
    on_bytes: Option<&dyn Fn(u64, Option<u64>)>,
) -> Result<Vec<u8>, String> {
  // 与镜像探测共用同一个 agent：代理与超时只有一处定义（见 mirror::agent）。
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
  // 没有它，一个谎报或持续产字的源就能把壳进程喂到 OOM —— 读满为止，超时前无人拦。
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

/// 不变量：判定依据与下载对象必须是同一种制品 —— macOS `osx-{arch}-tar`、Linux `linux-{arch}`、Windows `win-{arch}-zip`，各自解包成对应归档，三平台均零权限解包到 <状态根>/node。
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
        let newer = best.as_ref().map(|b| version_gt(ver, &b.0)).unwrap_or(true);
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

  let mut best: Option<(String, String, u128, String)> = None; // (ver, file, latency, src)
    for p in &probes {
        if !p.ok { continue; }
        let Some(body) = &p.body else { continue };
        let Some((ver, file)) = best_from_index(body) else { continue };
        let better = match &best {
            None => true,
            Some((bv, _, _, _)) => version_gt(&ver, bv),
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
  // 同步导出契约给内核（内核消费同一份目录；本机没装内核时写下也无害，装完就会读到）。
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

fn version_gt(a: &str, b: &str) -> bool {
    let va: Vec<u64> = a.trim_start_matches('v').split('.').filter_map(|x| x.parse().ok()).collect();
    let vb: Vec<u64> = b.trim_start_matches('v').split('.').filter_map(|x| x.parse().ok()).collect();
    for i in 0..3 {
        let x = va.get(i).copied().unwrap_or(0);
        let y = vb.get(i).copied().unwrap_or(0);
        if x != y { return x > y; }
    }
    false
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
    // SHASUMS 获取失败（网络失败 / 非 UTF-8 / 条目未找到同理）必须 continue：用 ? 会让一次限流或超时中断整条镜像回退链。
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

pub fn install(file: &Path) -> Result<PathBuf, String> {
    crate::platform::current().install_node(file)
}

pub fn outdated(installed: Option<&str>, latest: &str) -> bool {
    match installed {
        None => true,
        Some(v) => version_gt(latest, v),
    }
}

/// DSH 运行最低 Node 门槛（commander 要求 Node >= 22.12.0）；达到门槛即放行，不要求最新 LTS。
pub const MIN_NODE: &str = "v22.12.0";

pub fn meets_minimum(installed: Option<&str>) -> bool {
    match installed {
        None => false,
        Some(v) => !version_gt(MIN_NODE, v),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn version_compare() {
        assert!(version_gt("v2.0.0", "v1.9.9"));
        assert!(version_gt("v22.25.0", "v22.24.0"));
        assert!(!version_gt("v1.9.9", "v2.0.0"));
        assert!(!version_gt("v22.24.0", "v22.24.0"));
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

pub fn npm_manual_hint(version: &str) -> String {
    format!(
        "Node.js {} 已安装，但配套的 npm（{}）仍不可用。请手动安装 Node 官方分发包（自带 npm）后重试：\
         https://nodejs.org/dist/{}/ ；若本机 Node 为裁剪分发/解包不完整，请删除其安装目录后重新运行本安装。",
        version,
        crate::platform::current().npm_exe_name(),
        version
    )
}

/// `version` 由 `finalize_install` 传入已校验值；不兜空版本 —— 空版本一旦写进契约，下游每条「已就绪」播报都会念出一个看不见的号。
pub fn reinstall_for_npm(local: &Path, version: &str) -> Result<crate::runtime_contract::NodeRuntime, String> {
    // 重装可能把「另一个旧 Node」留在 PATH/记录里，故用安装器返回的路径直接复探（再问一次 PATH 可能拿到旧版本，与目标版本不一致 -> 永不收敛）。
    let node = install(local)?;
    let rt = crate::runtime_contract::derive_usable(&node, version)
        .ok_or_else(|| npm_manual_hint(version))?;
    crate::runtime_contract::write(&rt);
    Ok(rt)
}

pub fn finalize_install(
    node_bin: &Path,
    target: &str,
    local: &Path,
) -> Result<crate::runtime_contract::NodeRuntime, (bool, String)> {
    let v = crate::env::node_version(node_bin)
        .ok_or_else(|| (false, "安装后未能检测到 Node.js".to_string()))?;
    if v != target {
        return Err((false, format!("安装后版本 {} 与目标 {} 不一致", v, target)));
    }
    if !meets_minimum(Some(&v)) {
        return Err((false, format!("安装到的 Node.js {} 低于最低要求 {}", v, MIN_NODE)));
  }
    if let Some(rt) = crate::runtime_contract::derive_usable(node_bin, &v) {
        crate::runtime_contract::write(&rt);
        return Ok(rt);
    }
  crate::update::log("官方分发包未提供可用 npm，正在重新执行官方安装（幂等）…");
    reinstall_for_npm(local, &v).map_err(|e| (true, e))
}

pub fn probe_after() -> Option<(PathBuf, String)> {
    if let Some((p, v)) = crate::env::probe_system_node() { return Some((p, v)); }
    crate::env::known_install_node_path().and_then(|p| crate::env::node_version(&p).map(|v| (p, v)))
}

// 运行期契约只有 runtime_contract::write 单一写入点（两个写者会互相覆盖 npm 事实）。

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

/// 算法来源：Howard Hinnant 的 `civil_from_days`（公有领域，已被广泛验证）。
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
