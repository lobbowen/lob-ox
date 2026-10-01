//! 镜像源适配（壳自持）：装机时机器上没有内核，壳必须先于内核跑完镜像探测，内核消费壳投放的 registry.json。不变量：并行探测全部候选（串行会被最慢源拖死）；Node 版本取全部可达源中的最高版本（镜像同步滞后，首个成功即采用会装到旧版）；壳对内核只交证据（目录 + 探测规格 + 逐源实测），从不交选择。

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// npm registry 预设：仅元数据可读不算可用（部分镜像只代理元数据、不代理 tarball）。
pub const NPM_PRESETS: [&str; 6] = [
    "https://registry.npmmirror.com",
    "https://registry.npmjs.org",
    "https://repo.huaweicloud.com/repository/npm/",
    "https://mirrors.cloud.tencent.com/npm",
    "https://npmreg.proxy.ustclug.org",
    "https://r.cnpmjs.org",
];

pub const NODE_PRESETS: [&str; 10] = [
    "https://nodejs.org/dist",
    "https://npmmirror.com/mirrors/node",
    "https://mirrors.huaweicloud.com/nodejs",
    "https://mirrors.aliyun.com/nodejs-release",
    "https://mirror.sjtu.edu.cn/nodejs-release",
    "https://mirrors.cloud.tencent.com/nodejs-release",
    "https://mirror.nju.edu.cn/nodejs-release",
    "https://mirrors.tuna.tsinghua.edu.cn/nodejs-release",
    "https://mirrors.bfsu.edu.cn/nodejs-release",
    "https://mirrors.pku.edu.cn/nodejs-release",
];

/// 壳自更新清单预设（Tauri updater 的 endpoints，完整清单 URL）：必须是能直链**静态 JSON 文件**的源 —— 多数 npm 镜像只提供 registry 元数据 API，npmmirror /files/ 返回 403，npm 官方无静态文件服务。
pub const SHELL_PRESETS: [&str; 2] = [
    "https://unpkg.com/@lobox/shell-release@latest/shell-manifest.json",
    "https://cdn.jsdelivr.net/npm/@lobox/shell-release@latest/shell-manifest.json",
];

/// 安装包（清单里 `platforms.*.url` 指向的东西）的可换主机 npm CDN：入选判据是实测能把本平台安装包的完整字节取回（HTTP 200 + 全量），只看清单或元数据可达不算。
pub const SHELL_ARTIFACT_NPM_CDNS: [&str; 2] = [
    "https://unpkg.com",
    "https://cdn.jsdelivr.net/npm",
];

/// 安装包的另一类源：CI 挂上 GitHub Release 的同名安装程序（`shell-<ver>/<文件名>`）。⚠ tag 段是 `shell-<壳版本>`（不带 `v`，与 tauri.conf.json#version 直接对账），owner/repo 必须是真实发布仓 `lobbowen/lob-ox`：两段任一对不上都会 404，而它只是候选源之一，失败是静默换源、不会红。
pub const SHELL_ARTIFACT_RELEASE_BASE: &str =
    "https://github.com/lobbowen/lob-ox/releases/download";

/// 除清单声明的那一个 URL 外，安装包还该按序尝试哪些源（声明源永远第一）：Tauri 插件下载阶段不会自己换源，`Update::download_url` 是公开字段、壳可改写它；验签仍在插件内按清单签名做，任何源都没有让 updater 装上篡改包的能力。文件名不含架构标识时不挂 Release 候选（macOS 两架构产物同名，换过去取到的是错架构的包，表现为验签失败，更难排障）。
pub fn artifact_candidates(declared: &tauri::Url, ver: &str) -> Vec<tauri::Url> {
    let mut out = vec![declared.clone()];
    let path = declared.path().to_string();
    let file = path.rsplit('/').next().unwrap_or("").to_string();
    let mut add = |raw: String| {
        if let Ok(u) = tauri::Url::parse(&raw) {
            if !out.iter().any(|e| e == &u) {
                out.push(u);
            }
        }
    };
    if let Some(tail) = path.strip_prefix("/@lobox/") {
        for base in SHELL_ARTIFACT_NPM_CDNS {
            add(format!("{}/@lobox/{}", base, tail));
        }
    }
    if !ver.is_empty() && ARCH_TOKENS.iter().any(|a| file.contains(a)) {
        add(format!("{}/shell-{}/{}", SHELL_ARTIFACT_RELEASE_BASE, ver, file));
    }
    out
}

const ARCH_TOKENS: [&str; 5] = ["x64", "amd64", "x86_64", "arm64", "aarch64"];

/// 单次探测的总超时：index.json 单个就有 1.5~2MB（90+ 版本），过短的超时会让全部镜像在慢网/代理下一起超时，把「探针过短」误报成「全部 Node 镜像均不可用」。
pub const PROBE_TIMEOUT: Duration = Duration::from_secs(20);

/// 进程级 HTTP agent（统一代理与超时）：壳的全部 HTTP 都必须经本 agent，否则探测与下载会出现两套代理/超时行为。ureq 默认既不读环境变量也不读系统代理，「只有代理、没有直连」的机器上会全源直连必败而无从得知原因；故按 ALL_PROXY / HTTPS_PROXY / HTTP_PROXY（大小写）显式解析，无效地址忽略并记日志。
pub fn agent() -> &'static ureq::Agent {
    static A: std::sync::OnceLock<ureq::Agent> = std::sync::OnceLock::new();
    A.get_or_init(|| {
        let mut b = ureq::AgentBuilder::new().timeout(PROBE_TIMEOUT);
        if let Some(u) = proxy_url() {
            match ureq::Proxy::new(&u) {
                Ok(p) => { b = b.proxy(p); }
                Err(e) => { crate::update::log(&format!("代理地址无效，已忽略（{}）: {}", u, e)); }
            }
        } else {
            b = b.try_proxy_from_env(true);
        }
        b.build()
    })
}

fn proxy_url() -> Option<String> {
    for k in ["ALL_PROXY", "all_proxy", "HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"] {
        if let Ok(v) = std::env::var(k) {
            let v = v.trim();
            if !v.is_empty() { return Some(v.to_string()); }
        }
    }
    crate::platform::system_proxy()
}

pub fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// 一个 npm 源的最近一次实测结论。为什么逐源存而不是只存「选中的那个」：内核采用壳的证据的前提是证据覆盖它当前的**全部**候选，缺一源就得自己重测一轮 —— 只交一个结论等于不交。
#[derive(Clone)]
pub struct Measurement {
    pub origin: String,
    pub ok: bool,
    pub latency_ms: Option<u64>,
    pub error: Option<String>,
    pub checked_at: u64,
}

impl Measurement {
    fn json(&self) -> serde_json::Value {
        serde_json::json!({
            "origin": self.origin,
            "ok": self.ok,
            "latencyMs": self.latency_ms,
            "error": self.error,
            "checkedAt": self.checked_at,
        })
    }
}

fn measurement_from(v: &serde_json::Value) -> Option<Measurement> {
    let origin = v
        .get("origin")
        .and_then(|x| x.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())?;
    let checked_at = v.get("checkedAt").and_then(|x| x.as_u64()).filter(|t| *t > 0)?;
    Some(Measurement {
        origin,
        ok: v.get("ok").and_then(|x| x.as_bool()).unwrap_or(false),
        latency_ms: v.get("latencyMs").and_then(|x| x.as_u64()),
        error: v.get("error").and_then(|x| x.as_str()).map(|s| s.to_string()),
        checked_at,
    })
}

#[derive(Clone)]
pub struct Mirrors {
    pub node: Vec<String>,
    pub npm: Vec<String>,
    pub shell: Vec<String>,
    pub selected_node: Option<String>,
    pub npm_measurements: Vec<Measurement>,
}

impl Default for Mirrors {
    fn default() -> Self {
        Mirrors {
            node: NODE_PRESETS.iter().map(|s| s.to_string()).collect(),
            npm: NPM_PRESETS.iter().map(|s| s.to_string()).collect(),
            shell: SHELL_PRESETS.iter().map(|s| s.to_string()).collect(),
            selected_node: None,
            npm_measurements: Vec::new(),
        }
    }
}

fn cfg_path() -> PathBuf {
    crate::update::state_dir().join("mirrors.json")
}

/// 读取壳镜像配置；缺失或损坏时返回内置预设（**绝不失败** —— 装机首启必须可用）。
pub fn load() -> Mirrors {
    let mut m = Mirrors::default();
    if let Ok(s) = std::fs::read_to_string(cfg_path()) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&s) {
            let take = |key: &str| -> Option<Vec<String>> {
                v.get(key).and_then(|x| x.as_array()).map(|a| {
                    a.iter()
                        .filter_map(|x| x.as_str())
                        .map(|x| x.to_string())
                        .filter(|x| !x.is_empty())
                        .collect::<Vec<_>>()
                })
            };
            if let Some(list) = take("node") {
                if !list.is_empty() {
                    m.node = list;
                }
            }
            if let Some(list) = take("npm") {
                if !list.is_empty() {
                    m.npm = list;
                }
            }
            if let Some(list) = take("shell") {
                if !list.is_empty() {
                    m.shell = list;
                }
            }
            if let Some(s2) = v.get("selectedNode").and_then(|x| x.as_str()) {
                m.selected_node = Some(s2.to_string());
            }
            m.npm_measurements = v
                .get("npmMeasurements")
                .and_then(|x| x.as_array())
                .map(|a| a.iter().filter_map(measurement_from).collect())
                .unwrap_or_default();
        }
    }
    m
}

pub fn save(m: &Mirrors) -> Result<(), String> {
    let path = cfg_path();
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("创建壳状态目录失败: {}", e))?;
    }
    let v = serde_json::json!({
        "node": m.node,
        "npm": m.npm,
        "shell": m.shell,
        "selectedNode": m.selected_node,
        "npmMeasurements": m.npm_measurements.iter().map(|x| x.json()).collect::<Vec<_>>(),
    });
    let body = serde_json::to_string_pretty(&v).unwrap_or_default();
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, body + "\n").map_err(|e| format!("写入镜像配置失败: {}", e))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("提交镜像配置失败: {}", e))?;
    Ok(())
}

/// 契约 schema 版本（内核据此判断格式是否兼容）。按「谁写哪份」拆分：壳只交 catalog（镜像目录）/ probe（探测规格）/ measurements（逐源实测），mode 与 manualOrigin 一类的**选择**字段在内核自持的 registry-choice.json；内核照 probe 规格执行即可与壳得到同一答案。
pub const CONTRACT_SCHEMA: u64 = 3;

/// 契约文档本体（纯）：与写盘路径分开，便于独立校验形状。不变量：键集合恰为 schema/writtenBy/writtenAt/catalog/probe/measurements —— 出现任何 mode/manualOrigin/selected 一类的**选择**字段即为回归（那份所有权在内核）。
fn contract_doc(m: &Mirrors) -> serde_json::Value {
    serde_json::json!({
        "schema": CONTRACT_SCHEMA,
        "writtenBy": format!("shell@{}", env!("CARGO_PKG_VERSION")),
        "writtenAt": now_secs(),
        "catalog": m.npm,
        "probe": {
            "kind": "package-metadata",
            "pathTemplate": npm_probe_path(),
                        // 必须由 PROBE_TIMEOUT 派生（单一事实源）：两侧探测超时不一致时，介于两者之间的源会一侧判可达、另一侧判不可达，选源再次分叉。
            "timeoutMs": PROBE_TIMEOUT.as_millis() as u64,
        },
        "measurements": m.npm_measurements.iter().map(|x| x.json()).collect::<Vec<_>>(),
    })
}

/// 导出镜像契约给内核（`<产品状态根>/supervisor/registry.json`）：所有权在壳、方向单向（壳写内核读）—— 装壳那一刻机器上没有内核，壳必须先于内核跑完探测；由 main.rs setup 在启动时无条件导出。契约里一个字的选择都不写，所以内核固定过哪个源也不会让这份目录停止更新。
pub fn export_to_kernel(m: &Mirrors) -> Result<(), String> {
    if m.npm.is_empty() {
        return Ok(());
    }
    let path = crate::env::supervisor_dir().join("registry.json");
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("创建内核状态目录失败: {}", e))?;
    }
    let body = serde_json::to_string_pretty(&contract_doc(m)).unwrap_or_default();
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, body + "\n").map_err(|e| format!("写入内核 registry.json 失败: {}", e))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("提交内核 registry.json 失败: {}", e))?;
    Ok(())
}

/// 把一轮 npm 逐源探测落成契约证据、并重投契约：预热与面板手动重测两条路径共用此出口，否则「用户在引导页点了重新测速」的结果只留在内存，内核仍按旧证据选源。全部不可达时**清空**证据：留着旧结论会在其新鲜窗口内压住内核自测，网络恢复后面板仍显示一批死源；证据缺失时内核会自己测一轮（目录照投，只是不附结论）。
pub fn record_npm_measurements(probes: &[Probe]) {
    if probes.is_empty() {
        return;
    }
    let mut m = load();
    m.npm_measurements = if probes.iter().any(|p| p.ok) {
        let at = now_secs();
        probes
            .iter()
            .map(|p| Measurement {
                origin: p.source.clone(),
                ok: p.ok,
                latency_ms: Some(p.latency_ms as u64),
                error: p.error.clone(),
                checked_at: at,
            })
            .collect()
    } else {
        Vec::new()
    };
    if let Err(e) = save(&m) {
        crate::update::log(&format!("逐源测速结果落盘失败（不影响本次引导）: {}", e));
    }
    if let Err(e) = export_to_kernel(&m) {
        crate::update::log(&format!("重投镜像契约失败（下次启动或改目录时再投）: {}", e));
    }
}

/// 壳启动时无条件导出契约：探测失败时也必须写，否则内核完全拿不到源；失败只记日志，绝不阻断引导 —— 契约是增强，不是壳启动的前提。
pub fn export_on_boot() {
    let m = load();
    if let Err(e) = export_to_kernel(&m) {
        crate::update::log(&format!("启动导出镜像契约失败（不影响引导）: {}", e));
    }
}

pub struct Probe {
    pub source: String,
    pub ok: bool,
    pub latency_ms: u128,
    pub body: Option<String>,
    pub error: Option<String>,
}

/// npm registry 的探测探针包名（必须是一个真实存在的包）：多数 registry 根路径返回 404，用根路径会把健康源判为不可达、无谓地少一个可用镜像。用我们自己的平台包：真实存在，且与最终用途一致。
fn npm_probe_path() -> String {
    crate::core::package_name().unwrap_or_else(|_| "@lobox/dsh-core-linux-x64".to_string())
}

/// 用 std::thread::scope 实现并发（std 自带，无需新依赖）：单源超时 PROBE_TIMEOUT，整体耗时约为最慢者而非累加；`path` 为空时视为 npm registry 探测（用真实包名而非根路径）。
pub fn probe_all(sources: &[String], path: &str) -> Vec<Probe> {
    let owned;
    let path = if path.is_empty() {
        owned = npm_probe_path();
        owned.as_str()
    } else {
        path
    };
    let out: Mutex<Vec<Probe>> = Mutex::new(Vec::new());
    std::thread::scope(|scope| {
        for src in sources {
            let out = &out;
            scope.spawn(move || {
                let url = format!(
                    "{}/{}",
                    src.trim_end_matches("/"),
                    path.trim_start_matches("/")
                );
                let started = Instant::now();
                let mut probe = Probe {
                    source: src.clone(),
                    ok: false,
                    latency_ms: 0,
                    body: None,
                    error: None,
                };
                match agent().get(&url).timeout(PROBE_TIMEOUT).call() {
                    Ok(resp) => {
                        let mut buf = Vec::new();
                        use std::io::Read;
                        match resp.into_reader().read_to_end(&mut buf) {
                            Ok(_) => {
                                probe.latency_ms = started.elapsed().as_millis();
                                probe.ok = true;
                                probe.body = Some(String::from_utf8_lossy(&buf).into_owned());
                            }
                            Err(e) => {
                                probe.latency_ms = started.elapsed().as_millis();
                                probe.error = Some(format!("读取响应失败: {}", e));
                            }
                        }
                    }
                    Err(e) => {
                        probe.latency_ms = started.elapsed().as_millis();
                        probe.error = Some(format!("{}", e));
                    }
                }
                out.lock().unwrap_or_else(|e| e.into_inner()).push(probe);
            });
        }
    });
    let mut v = out.into_inner().unwrap_or_default();
    v.sort_by(|a, b| match (a.ok, b.ok) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.latency_ms.cmp(&b.latency_ms),
    });
    v
}

// 形态尺：什么才算「一个镜像源」、什么才算「一个可下载的产物地址」。与内核 distribution/registry-ref.js 的 parseRegistryBase 逐条对齐；两仓语言不同、只能各有一份实现，故判据以双侧同表 golden vectors 钉死。

pub fn normalize_base(raw: &str) -> String {
    raw.trim().trim_end_matches('/').to_string()
}

/// 主机是不是回环/私网/链路本地/保留段字面量（内核 shared/ip.js 的 isPrivateHostLiteral 同尺）。只判字面量：DNS 记录指到内网不在射程内。IPv6 字面量整族拒绝 —— 壳没有任何正当用途要访问它。
fn private_host_literal(host: &str) -> bool {
    use std::net::IpAddr;
    let h = host.trim_start_matches('[').trim_end_matches(']').to_lowercase();
    if h.is_empty() || h.contains(':') || !h.contains('.') {
        return true;
    }
    if h == "localhost" || h.ends_with(".localhost") || h.ends_with(".local")
        || h.ends_with(".internal") || h.ends_with(".home.arpa")
    {
        return true;
    }
    match h.parse::<IpAddr>() {
        Ok(IpAddr::V6(_)) => true,
        Ok(IpAddr::V4(v4)) => {
            let o = v4.octets();
            v4.is_loopback() || v4.is_private() || v4.is_link_local()
                || o[0] == 0 || o[0] >= 224 || (o[0] == 100 && (64..=127).contains(&o[1]))
        }
        Err(_) => false,
    }
}

fn checked_http_url(raw: &str, noun: &str) -> Result<tauri::Url, String> {
    let s = raw.trim();
    if s.is_empty() {
        return Err(format!("{}为空", noun));
    }
    if s.chars().any(|c| c.is_whitespace()) {
        return Err(format!("{}不得含空白字符", noun));
    }
    let u = tauri::Url::parse(s).map_err(|_| format!("{}无法解析: {}", noun, s))?;
    if u.scheme() != "http" && u.scheme() != "https" {
        return Err(format!("{}必须是 http(s) 协议: {}", noun, s));
    }
    if !u.username().is_empty() || u.password().is_some() {
        return Err(format!("{}不得携带用户名或密码: {}", noun, s));
    }
    if u.host_str().unwrap_or("").is_empty() {
        return Err(format!("{}缺少主机名: {}", noun, s));
    }
    Ok(u)
}

/// 配置形态的镜像基址（面板可填、可进契约 catalog 的那种）：允许带 path —— 华为云/腾讯云 npm 就是这个形态；但凭证、查询串、片段一律拒 —— 它们会把「同一个源」变成两个身份不同的地址。
pub fn registry_base(raw: &str) -> Result<String, String> {
    let base = normalize_base(raw);
    let u = checked_http_url(&base, "镜像源")?;
    if u.query().is_some() {
        return Err(format!("镜像源不得携带查询串: {}", base));
    }
    if u.fragment().is_some() {
        return Err(format!("镜像源不得携带片段: {}", base));
    }
    Ok(base)
}

/// 由远端元数据给出的下载目标（npm `dist.tarball`）。与配置基址差两点：查询串**必须允许**（签名 CDN 的凭据参数就在 query 里，砍掉等于装不上这类镜像），主机**必须过私网闸** —— 这个主机不是操作者选的而是 registry 选的，等价于一次跨主机跳转。
pub fn asset_url(raw: &str) -> Result<String, String> {
    let u = checked_http_url(raw, "下载地址")?;
    if u.fragment().is_some() {
        return Err(format!("下载地址不得携带片段: {}", u.as_str()));
    }
    if private_host_literal(u.host_str().unwrap_or("")) {
        return Err(format!("下载地址主机不得为回环/私网/链路本地字面量: {}", u.host_str().unwrap_or("")));
    }
    Ok(u.as_str().to_string())
}


static WARM: std::sync::OnceLock<Mutex<Option<ProbeSnapshot>>> = std::sync::OnceLock::new();

fn warm() -> &'static Mutex<Option<ProbeSnapshot>> {
    WARM.get_or_init(|| Mutex::new(None))
}

#[derive(Clone)]
pub struct ProbeSnapshot {
    pub node_best: Option<String>,
    pub node_latency_ms: Option<u128>,
    pub npm_best: Option<String>,
    pub npm_latency_ms: Option<u128>,
    pub npm_probes: Vec<(String, bool, u128)>,
    pub at: u64,
}

pub fn cached() -> Option<ProbeSnapshot> {
    match warm().lock() {
        Ok(g) => g.clone(),
        Err(e) => e.into_inner().clone(),
    }
}

static WARMING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// 离开线程体（正常返回或 panic）就把 WARMING 落下。手写 `store(false)` 只覆盖不 panic 的路径：探测链上任一处 panic 都会让标记永久停在 true，此后每次预热都被第一行的 swap 挡掉 —— 表现为 registry 那一格再也不更新，且无日志。
struct WarmingGuard;
impl Drop for WarmingGuard {
    fn drop(&mut self) {
        WARMING.store(false, std::sync::atomic::Ordering::SeqCst);
    }
}

pub fn warmup_async() {
    if WARMING.swap(true, std::sync::atomic::Ordering::SeqCst) {
        return;
    }
        // 线程开不起来时**必须**回滚 WARMING：它在上面已置 true，留着就永久没有下一次预热，registry 那一格会一直停在「测速尚未完成」，且没有任何地方能解释为什么。
    let spawned = std::thread::Builder::new()
        .name("mirror-warmup".to_string())
        .spawn(|| {
            let _warming = WarmingGuard;
            let m = load();
            let node_p = probe_all(&m.node, "index.json");
            let npm_p = probe_all(&m.npm, "");
            let pick = |v: &[Probe]| -> (Option<String>, Option<u128>) {
                let best = v.iter().find(|p| p.ok);
                (best.map(|p| p.source.clone()), best.map(|p| p.latency_ms))
            };
            let pick_all = |v: &[Probe]| -> Vec<(String, bool, u128)> {
                v.iter().map(|p| (p.source.clone(), p.ok, p.latency_ms)).collect()
            };
            let (nb, nl) = pick(&node_p);
            let (mb, ml) = pick(&npm_p);
            let mp = pick_all(&npm_p);
            let snap = ProbeSnapshot {
                node_best: nb,
                node_latency_ms: nl,
                npm_best: mb,
                npm_latency_ms: ml,
                npm_probes: mp,
                at: now_secs(),
            };
                        // 结果必须落盘并重投契约（规则只在一处，见 record_npm_measurements）：只放内存快照的话，内核拿到的永远是「壳没测过」，它会自己再跑一轮同样的探测。
            record_npm_measurements(&npm_p);
            match warm().lock() {
                Ok(mut g) => *g = Some(snap),
                Err(e) => *e.into_inner() = Some(snap),
            }
        });
    if let Err(e) = spawned {
        WARMING.store(false, std::sync::atomic::Ordering::SeqCst);
        crate::update::log(&format!("镜像预热线程未能启动（{}）：本轮 registry 维度无从判定", e));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(s: &str) -> tauri::Url {
        tauri::Url::parse(s).expect("测试内的 URL 必须是合法的")
    }
    fn strs(v: &[tauri::Url]) -> Vec<String> {
        v.iter().map(|u| u.to_string()).collect()
    }

    #[test]
    fn declared_source_stays_first_and_deduped() {
        let d = url("https://unpkg.com/@lobox/shell-win-x64@1.2.0/artifact/dsh-supervisor_1.2.0_x64-setup.exe");
        let got = artifact_candidates(&d, "1.2.0");
        assert_eq!(got[0], d, "第一个候选必须是清单声明的那个 URL");
        let all = strs(&got);
        assert_eq!(all.len(), all.iter().collect::<std::collections::HashSet<_>>().len(),
            "候选不能重复: {:?}", all);
    }

        /// Windows：npm 换主机 + 同名 Release 资产；且**绝不**出现实测不成立的源（实测取不到安装包字节的源，一律不许回到表里）。
    #[test]
    fn windows_candidates_cover_measured_sources_only() {
        let d = url("https://unpkg.com/@lobox/shell-win-x64@1.2.0/artifact/dsh-supervisor_1.2.0_x64-setup.exe");
        let all = strs(&artifact_candidates(&d, "1.2.0"));
        assert!(all.iter().any(|u| u.starts_with("https://cdn.jsdelivr.net/npm/@lobox/shell-win-x64@1.2.0/")),
            "jsdelivr 的 npm 路径要在（它对 .exe 会给 403，换下一个源是预期）: {:?}", all);
        assert!(all.contains(&"https://github.com/lobbowen/lob-ox/releases/download/shell-1.2.0/dsh-supervisor_1.2.0_x64-setup.exe".to_string()),
            "文件名带架构 → 同名 Release 资产要在（owner/repo = 合仓后的发布仓 lobbowen/lob-ox）: {:?}", all);
        for banned in [
            "npmmirror", "jsdmirror", "fastly", "gcore", "testingcf",
            "tencent", "aliyun", "huaweicloud", "unpkg.net", "gh-proxy", "ghfast", "gitmirror",
        ] {
            assert!(all.iter().all(|u| !u.contains(banned)),
                "假镜像回流: {} 出现在 {:?}", banned, all);
        }
    }

    #[test]
    fn ambiguous_asset_name_loses_the_release_candidate() {
        let d = url("https://unpkg.com/@lobox/shell-darwin-arm64@1.2.0/artifact/dsh-supervisor.app.tar.gz");
        let all = strs(&artifact_candidates(&d, "1.2.0"));
        assert!(all.iter().all(|u| !u.contains("releases/download")),
            "文件名不含架构时不该挂 Release 候选: {:?}", all);
    }

    #[test]
    fn foreign_or_missing_version_yields_only_the_declared_url() {
        let d = url("https://example.com/files/shell-setup.exe");
        assert_eq!(strs(&artifact_candidates(&d, "1.2.0")), vec![d.to_string()]);
        let npm = url("https://unpkg.com/@lobox/shell-linux-x64@1.2.0/artifact/dsh-supervisor_1.2.0_amd64.deb");
        let nover = strs(&artifact_candidates(&npm, ""));
        assert_eq!(nover.len(), 2, "无版本号时只保留 npm 同路径候选: {:?}", nover);
    }

    #[test]
    fn registry_base_golden_vectors() {
        let accepted: [(&str, &str); 7] = [
            ("https://registry.npmmirror.com", "https://registry.npmmirror.com"),
            ("  https://registry.npmmirror.com/  ", "https://registry.npmmirror.com"),
            ("https://repo.huaweicloud.com/repository/npm/", "https://repo.huaweicloud.com/repository/npm"),
            ("https://mirrors.cloud.tencent.com/npm", "https://mirrors.cloud.tencent.com/npm"),
            ("https://x.example/a//", "https://x.example/a"),
            ("http://192.168.1.10:4873", "http://192.168.1.10:4873"),
            ("http://localhost:4873", "http://localhost:4873"),
        ];
        for (raw, want) in accepted {
            assert_eq!(registry_base(raw).ok().as_deref(), Some(want), "合法基址被判死: {}", raw);
        }
        let rejected: [&str; 8] = [
            "",
            "   ",
            "not-a-url",
            "ftp://mirror.example/pub",
            "https://user:pass@registry.example.com",
            "https://registry.example.com?token=1",
            "https://registry.example.com/doc/#frag",
            "https://registry.example.com /npm",
        ];
        for raw in rejected {
            assert!(registry_base(raw).is_err(), "非法基址被放过: {:?}", raw);
        }
        assert!(registry_base("http://192.168.1.10:4873").is_ok());
    }

    #[test]
    fn private_host_literal_golden_vectors() {
        let private: [&str; 16] = [
            "127.0.0.1", "127.0.0.2", "10.1.2.3", "172.16.0.1", "192.168.1.10",
            "169.254.169.254", "100.64.1.2", "100.127.0.1", "0.0.0.0", "0.1.2.3",
            "224.0.0.1", "239.1.2.3", "localhost", "verdaccio.internal", "nas.local", "intranet.home.arpa",
        ];
        for h in private {
            assert!(private_host_literal(h), "该主机必须判为非公网: {}", h);
        }
        let public: [&str; 7] = [
            "registry.npmmirror.com", "cdn.jsdelivr.net", "1.1.1.1", "8.8.8.8",
            "172.32.0.1", "100.128.0.1", "169.253.1.1",
        ];
        for h in public {
            assert!(!private_host_literal(h), "公网主机被误判为私网: {}", h);
        }
        // IPv6 整族（含带方括号的 URL hostname 形态）与单标签短名一律非公网信任集。
        for h in ["::1", "fe80::1", "[::1]", "[fd00::1]", "intranet", ""] {
            assert!(private_host_literal(h), "该主机必须判为非公网: {:?}", h);
        }
        assert!(private_host_literal("LocalHost"));
    }

    #[test]
    fn asset_url_allows_signed_query_but_not_private_hosts() {
        assert_eq!(
            asset_url("https://cdn.example.com/a/b.tgz?sig=1&x=2").ok().as_deref(),
            Some("https://cdn.example.com/a/b.tgz?sig=1&x=2")
        );
        assert!(asset_url("https://registry.npmjs.org/@lobox%2Fdsh-core-linux-x64/-/dsh-core-linux-x64-0.1.6.tgz").is_ok());
        let rejected: [&str; 9] = [
            "http://169.254.169.254/latest/meta-data/pkg.tgz",
            "http://127.0.0.1:4873/pkg.tgz",
            "http://[::1]:8080/pkg.tgz",
            "http://localhost:4873/pkg.tgz",
            "http://100.64.1.2/pkg.tgz",
            "http://verdaccio.internal/pkg.tgz",
            "file:///etc/passwd",
            "https://u:p@host.example.com/a.tgz",
            "https://host.example.com/a.tgz#sha512-x",
        ];
        for raw in rejected {
            assert!(asset_url(raw).is_err(), "该产物地址必须被拒: {}", raw);
        }
    }

        /// 契约形状：键集合**等值**而非「含 catalog」—— 回潮一个 mode/selected 会红在这里，而只数条数的话它照样绿。
    #[test]
    fn contract_doc_is_evidence_only() {
        let m = Mirrors {
            npm: vec!["https://registry.npmmirror.com".to_string()],
            npm_measurements: vec![Measurement {
                origin: "https://registry.npmmirror.com".to_string(),
                ok: true,
                latency_ms: Some(42),
                error: None,
                checked_at: 1_700_000_000,
            }],
            ..Default::default()
        };
        let d = contract_doc(&m);
        let mut keys: Vec<String> = d
            .as_object()
            .expect("契约必须是 JSON 对象")
            .keys()
            .map(|k| k.to_string())
            .collect();
        keys.sort();
        assert_eq!(
            keys,
            vec!["catalog", "measurements", "probe", "schema", "writtenAt", "writtenBy"]
                .iter().map(|s| s.to_string()).collect::<Vec<String>>(),
            "契约键集合变了（多出来的那个大概率是选择字段回潮）: {:?}",
            keys
        );
        assert_eq!(d["schema"], serde_json::json!(CONTRACT_SCHEMA));
        assert_eq!(d["probe"]["timeoutMs"], serde_json::json!(PROBE_TIMEOUT.as_millis() as u64));
        let ms = d["measurements"].as_array().expect("measurements 须为数组");
        assert_eq!(ms[0]["latencyMs"], serde_json::json!(42));
        assert_eq!(ms[0]["ok"], serde_json::json!(true));
        assert!(ms[0]["error"].is_null(), "没有拒因写 null，不写空串（面板据此区分失败与没失败）");
    }

    #[test]
    fn measurement_round_trip_drops_undated_entries() {
        let m = Measurement {
            origin: "https://a.example".to_string(),
            ok: false,
            latency_ms: None,
            error: Some("HTTP 404".to_string()),
            checked_at: 7,
        };
        let back = measurement_from(&m.json()).expect("往返必须成功");
        assert_eq!(back.origin, m.origin);
        assert_eq!(back.checked_at, 7);
        assert!(!back.ok);
        assert!(back.latency_ms.is_none());
        assert_eq!(back.error.as_deref(), Some("HTTP 404"));
        assert!(measurement_from(&serde_json::json!({"origin": "https://a.example", "ok": true})).is_none());
        assert!(measurement_from(&serde_json::json!({"origin": "  ", "ok": true, "checkedAt": 7})).is_none());
    }
}
