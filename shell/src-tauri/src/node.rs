use serde_json::Value;
use sha2::{Digest, Sha256};
use std::io::Read;
use std::path::{Path, PathBuf};

// 镜像候选已收敛到 mirror.rs 的 NODE_PRESETS（壳自持配置，支持用户自定义）。

/// 整个请求的时间上限（ureq 的 timeout 覆盖整次调用，含响应体读取）。
/// Node 安装包 30-90MB，必须给足；否则慢网下会误报为网络故障。
const HTTP_TOTAL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15 * 60);

/// 取回整个响应体（不关心进度的小文件：SHASUMS256.txt、index.json）。
fn http_get_bytes(url: &str) -> Result<Vec<u8>, String> {
    http_get_bytes_progress(url, None, None)
}

/// 取回整个响应体，边下边报字节进度。`on_bytes(已取回, 总量)`：总量优先取响应头的 Content-Length，
/// 没有就用 `total_hint`（调用方从别处已知的真实大小，如 registry 的 `dist.size`），两者都没有才是
/// None。按块回调而不是整块：Node 官方归档 30~90MB，慢网下整块读取要数分钟，而这段时间此前对 UI
/// 完全不可见。`pub(crate)`：全仓只有这一个带进度的 GET，内核包下载必须复用它而非再写一份客户端。
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
  // 预分配只是省扩容，因此对声称的大小设上限（Content-Length 由服务端给，不可全信）。
    let mut buf = Vec::with_capacity(total.unwrap_or(0).min(64 * 1024 * 1024) as usize);
  // 字节上限：声称的总量 + 1MB 抖动，无总量时给 512MB 硬顶（本平台最大归档约 90MB）。
  // 没有它，一个谎报或持续产字的源就能把壳进程喂到 OOM —— 读满为止，超时前无人拦。
    let cap = total.map(|t| t.saturating_add(1024 * 1024)).unwrap_or(512 * 1024 * 1024);
    let mut reader = resp.into_reader();
    let mut chunk = [0u8; 64 * 1024];
  // 每 64KB 一次回调会打出上百条事件；按「总量的 1%」或「512KB（无总量时）」节流。
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
  // 收尾必报一次真实总量：否则最后一段字节（可能占总量近 1%）永远不在进度里，
  //  「已取回 45.1 / 45.6 MB」会被读成下载停住。
    if let Some(cb) = on_bytes {
        cb(buf.len() as u64, total);
    }
    Ok(buf)
}

/// 本平台在官方 index.json 中的平台标签（必须与 `platform_artifact()` 的产物语义一致）。
/// 不变量：判定依据与下载对象必须是同一种制品 —— macOS `osx-{arch}-tar`、Linux `linux-{arch}`、
/// Windows `win-{arch}-zip`，各自解包成对应归档，三平台均零权限解包到 <状态根>/node。
fn platform_artifact(version: &str) -> Option<crate::platform::NodeArtifact> {
    crate::platform::current().node_artifact(version)
}

/// 从一个 index.json 文本中解析「本平台可用的最高 LTS」。
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
  // 标签与文件名**同源**（平台层一次给出）——
// 标签与文件名同源（平台层一次给出），避免判定与下载对象不一致。
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

/// 镜像发现结果：最高 LTS + 提供该版本的**最快**源。
pub struct LtsChoice {
    pub version: String,
    pub file: String,
    pub source: String,
    pub latency_ms: u128,
    pub probes: Vec<(String, bool, u128)>,
}

/// **并行**探测全部 Node 镜像，取「最高 LTS」并选最快且提供该版本的源。
/// 取全部可达源的最高版本（镜像同步滞后，「首个成功即采用」会装到旧版）；
/// 在提供该版本的源中选延迟最低者，避免用慢源拉大包。
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
  // 落盘缓存：记录选中的 Node 源（镜像选择**可观测** —— 用户与排障都能看到当前用的是哪个源）。
            let mut m = crate::mirror::load();
            m.selected_node = Some(source.clone());
            if let Err(e) = crate::mirror::save(&m) {
                crate::update::log(&format!("镜像配置写入失败（不影响本次安装）: {}", e));
            }
  // 同步导出契约给内核（内核消费同一份目录；本机没装内核时写下也无害，装完就会读到）。
  // 这里选中的是 Node 发行源，与契约的 npm 逐源实测无关，所以不碰 measurements。
            if let Err(e) = crate::mirror::export_to_kernel(&m) {
                crate::update::log(&format!("导出内核镜像偏好失败（不影响本次安装）: {}", e));
            }
            Ok(LtsChoice { version, file, source, latency_ms, probes: diag })
        }
        None => {
  // 失败原因必须逐源带出（HTTP / DNS / TLS / 代理 / 读体），而不是一句「不可达」。
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

/// 下载 + SHASUMS256 强校验，返回本地文件路径。源顺序：优先用发现阶段选出的最快源（`preferred`），
/// 其余候选作为回退；校验失败（哈希不符）视为该源不可信，换下一个源重试 —— 既保证正确性，也避免被单个镜像的损坏文件卡死。
/// `on_bytes` 只回调归档下载的字节进度（已取回 / 总量，总量可为 None）；SHASUMS256.txt 是几十 KB 附属文件，不占进度语义。
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
  // 镜像回退必须在 SHASUMS 失败时也能继续：写成 `String::from_utf8(http_get_bytes(...)?)` 时外层 `?`
  // 让网络失败直接 return，下面的 `continue` 只覆盖非 UTF-8 情形 —— 一次限流或超时即中断整条回退链，
  // 即使后续镜像完全健康，与本函数上方「校验失败换下一个源」的承诺矛盾。条目未找到（`ok_or_else(...)?`）
  // 同理改为 continue。
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

/// 平台安装：官方产物 + 一次性系统授权弹窗。实现已下沉到 platform 层（三平台的提权通道与安装器各不相同，
/// 现统一为用户级归档解包，零权限，见 ENV-TOOLCHAIN-INSTALL-STANDARD）。
/// 这是壳独有的能力：装内核之前必须先把运行环境装好（引导顺序 R1），而提权需要人在场 —— 无头的内核永远做不到。
pub fn install(file: &Path) -> Result<PathBuf, String> {
    crate::platform::current().install_node(file)
}

pub fn outdated(installed: Option<&str>, latest: &str) -> bool {
    match installed {
        None => true,
        Some(v) => version_gt(latest, v),
    }
}

/// DSH 运行最低 Node 门槛（commander 要求 Node >= 22.12.0， 核实）。
/// 引导策略：达到最低标准即放行（不要求最新 LTS）——旧于最新但 >= 门槛直接进后续。
pub const MIN_NODE: &str = "v22.12.0";

/// 是否达到 DSH 最低 Node 要求：None（未装）-> false；已装 -> 版本 >= MIN_NODE。
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

/// npm 仍缺失时的**可操作**文案（ENV-TOOLCHAIN-INSTALL-STANDARD，必须给手动安装指引）。
/// 经平台层取 npm 可执行名（G1：平台差异只在 platform 层）。
pub fn npm_manual_hint(version: &str) -> String {
    format!(
        "Node.js {} 已安装，但配套的 npm（{}）仍不可用。请手动安装 Node 官方分发包（自带 npm）后重试：\
         https://nodejs.org/dist/{}/ ；若本机 Node 为裁剪分发/解包不完整，请删除其安装目录后重新运行本安装。",
        version,
        crate::platform::current().npm_exe_name(),
        version
    )
}

/// 重新执行官方安装以补齐 npm（幂等）。复用已下载且 SHA256 校验通过的同一产物，不重新下载：
/// 再下一遍会把「补 npm」拖成一次完整重装，让用户多等一个 30~50MB 的下载。失败一律归 npm 步骤。
/// `version` 由 `finalize_install` 传入已校验值；不 `unwrap_or_default()` 兜空版本 —— 空版本一旦写进契约，
/// 下游每一条「已就绪」播报都会念出一个看不见的号。
pub fn reinstall_for_npm(local: &Path, version: &str) -> Result<crate::runtime_contract::NodeRuntime, String> {
  // 重装可能把「另一个旧 Node」留在 PATH/记录里，故用安装器返回的路径直接复探，
    //   而不是再问一次 PATH（否则可能拿到旧版本，与目标版本不一致 -> 永不收敛）。
    let node = install(local)?;
    let rt = crate::runtime_contract::derive_usable(&node, version)
        .ok_or_else(|| npm_manual_hint(version))?;
    crate::runtime_contract::write(&rt);
    Ok(rt)
}

/// 安装收尾（ENV-TOOLCHAIN-INSTALL-STANDARD）：校验 node（版本 + 最低门槛）-> 校验 npm ->
/// 不可用则重装补 npm（幂等）。成功返回运行期契约本身，而不是再拼一份字段子集：外层每一条播报必须出自
/// 同一份事实，否则会出现「拿 node 版本当 npm 版本念出去」那类无从校验的口径分叉。
/// 失败以 bool 区分归属（true=npm / false=node）。这段属于 node.rs 而非 main.rs：G3 要求 main.rs 只做组装。
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
  // derive_usable 内部就是一次真实执行 npm（T-1b）：None 即「npm 不可用」，
    //   不需要先单独判可用再 derive_usable —— 那会把同一个 npm 探测执行两遍。
    if let Some(rt) = crate::runtime_contract::derive_usable(node_bin, &v) {
        crate::runtime_contract::write(&rt);
        return Ok(rt);
    }
  crate::update::log("官方分发包未提供可用 npm，正在重新执行官方安装（幂等）…");
  // 直接返回重装后的契约：路径/版本以安装器**这次**给出的为准（旧实现把重装前的 node_bin
    //   报出去，一旦重装换了落点，外层拿到的就是一个不再存在的路径）。
    reinstall_for_npm(local, &v).map_err(|e| (true, e))
}

/// 安装后复探（PATH 优先，其次已知落点）。
pub fn probe_after() -> Option<(PathBuf, String)> {
    if let Some((p, v)) = crate::env::probe_system_node() { return Some((p, v)); }
    crate::env::known_install_node_path().and_then(|p| crate::env::node_version(&p).map(|v| (p, v)))
}

// record_runtime_meta 已删除：它与 runtime_contract::write 是
// **两个写者**写同一个 <supervisor_dir>/runtime.json，且它不写 npmPath/npmArgs/schema ——
// 在 runtime_contract::write 之后调用会把 npm 事实整体覆盖掉（随后 read_node() 还会用
// 不存在的 bin/npm 伪造路径）。运行时纪要现由 runtime_contract::write 单一写入。

/// 当前 UTC 时间，ISO 8601（`YYYY-MM-DDTHH:MM:SSZ`）。
/// 纯 std 计算（Howard Hinnant civil-from-days），三平台一致、无副作用；
/// 格式与内核侧 `new Date().toISOString()` 同族，可被下游直接解析。
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

/// 把「自 1970-01-01 起的天数」转为 (年, 月, 日)。
/// 算法来源：Howard Hinnant 的 `civil_from_days`（公有领域，已被广泛验证）。
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
  let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
  let doe = z - era * 146_097;  // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365; // [0, 399]
  let y = yoe + era * 400;
  let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);  // [0, 365]
  let mp = (5 * doy + 2) / 153;  // [0, 11]
  let d = (doy - (153 * mp + 2) / 5 + 1) as u32;  // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;       // [1, 12]
    (if m <= 2 { y + 1 } else { y }, m, d)
}
