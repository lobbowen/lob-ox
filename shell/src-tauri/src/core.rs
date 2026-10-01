// 内核版本治理：目标高于本机就必须更新；回退只走显式 dist-tags.rollback 通道（版本比较认不出回退，故选版依据 via 下传给 build_plan，升级/回退共用同一执行路径）。

// 镜像顺序取内核自持的 registry-choice.json（manual 用 manualOrigin，否则其候选）；该文档缺失时退回壳自持目录。

// 安装前缀从已定位内核的真实路径反推，绝不用 npm prefix -g：nvm/自定义 prefix 下两者可能不一致，直接装会把新内核装到别处、旧内核继续遮蔽（「更新了却没生效」）。

use serde_json::Value;
use std::path::{Path, PathBuf};

/// 平台 -> npm 子包名（唯一真源；错误提示/安装/查询共用，杜绝散落硬编码）。
pub fn package_name() -> Result<String, String> {
    let tag = crate::platform::current()
        .core_platform_tag()
        .ok_or_else(|| "当前平台/架构无对应的内核发布包".to_string())?;
    Ok(format!("@lob-ox/dsh-core-{}", tag))
}

pub fn npm_exe() -> &'static str {
    crate::platform::current().npm_exe_name()
}

fn num_ok(s: &str) -> bool {
    if s.is_empty() { return false; }
    if s.len() > 1 && s.starts_with('0') { return false; }
    s.chars().all(|c| c.is_ascii_digit())
}

/// 行为规格由 `shell-release/version-vectors.json` 锁定（内核侧逐字节相同的一份）：跨语言无法共享代码，但可共享行为规格，两侧测试都按它断言。
pub fn is_valid_version(v: &str) -> bool {
    let mut it = v.splitn(2, '+');
    let core = it.next().unwrap_or("");
    let build = it.next();

    let mut core_it = core.splitn(2, '-');
    let nums = core_it.next().unwrap_or("");
    let parts: Vec<&str> = nums.split('.').collect();
    if parts.len() != 3 || !parts.iter().all(|p| num_ok(p)) { return false; }
    if let Some(pre) = core_it.next() {
        if pre.is_empty() { return false; }
        for seg in pre.split('.') {
            if seg.is_empty() || !seg.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') { return false; }
        }
    }

    if let Some(b) = build {
        if b.is_empty() { return false; }
        for seg in b.split('.') {
            if seg.is_empty() || !seg.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') { return false; }
        }
    }
    true
}

/// semver 比较（与内核 semverCompare 同语义）：数值段优先；release > prerelease；预发布内「数字段 < 字符串段」；build metadata 不参与。返回 -1/0/1。
pub fn semver_cmp(a: &str, b: &str) -> i32 {
    let parse = |v: &str| -> (Vec<i64>, String) {
        let clean = v.split('+').next().unwrap_or("").to_string();
        let mut it = clean.splitn(2, '-');
        let core = it.next().unwrap_or("").to_string();
        let pre = it.next().unwrap_or("").to_string();
        (core.split('.').map(|x| x.parse::<i64>().unwrap_or(0)).collect(), pre)
    };
    let (an, ap) = parse(a);
    let (bn, bp) = parse(b);
    for i in 0..3 {
        let x = an.get(i).copied().unwrap_or(0);
        let y = bn.get(i).copied().unwrap_or(0);
        if x != y { return if x > y { 1 } else { -1 }; }
    }
    if ap == bp { return 0; }
    if ap.is_empty() { return 1; }
    if bp.is_empty() { return -1; }
    let av: Vec<&str> = ap.split('.').collect();
    let bv: Vec<&str> = bp.split('.').collect();
    let n = av.len().max(bv.len());
    for i in 0..n {
        match (av.get(i), bv.get(i)) {
            (None, _) => return -1,
            (_, None) => return 1,
            (Some(x), Some(y)) => {
                let xn = x.chars().all(|c| c.is_ascii_digit());
                let yn = y.chars().all(|c| c.is_ascii_digit());
                if xn && yn {
                    let xi: i64 = x.parse().unwrap_or(0);
                    let yi: i64 = y.parse().unwrap_or(0);
                    if xi != yi { return if xi > yi { 1 } else { -1 }; }
                } else if xn != yn {
                    return if xn { -1 } else { 1 };
                } else if x != y {
                    return if x < y { -1 } else { 1 };
                }
            }
        }
    }
    0
}

/// 内核自持的镜像选择文档（`<产品状态根>/supervisor/registry-choice.json`，只有内核写）：壳读它只为一件事 —— 用户在内核面板固定过源时，壳的安装/更新必须打在同一个源上。
struct KernelChoice {
    manual: Option<String>,
    origins: Vec<String>,
}

fn kernel_choice() -> Option<KernelChoice> {
    let s = std::fs::read_to_string(crate::env::supervisor_dir().join("registry-choice.json")).ok()?;
    let v = serde_json::from_str::<Value>(&s).ok()?;
    let manual = if v.get("mode").and_then(|x| x.as_str()) == Some("manual") {
        v.get("manualOrigin")
            .and_then(|x| x.as_str())
            .map(|t| t.trim().to_string())
            .filter(|t| !t.is_empty())
    } else {
        None
    };
    let origins = v
        .get("origins")
        .and_then(|x| x.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str())
                .map(|t| t.trim().to_string())
                .filter(|t| !t.is_empty())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    Some(KernelChoice { manual, origins })
}

/// 镜像候选集合，优先序与内核 policies.effectiveOrigins 一致：内核手动固定的源 > 内核里用户维护的候选 > 壳自持目录。不读壳投出的契约候选 —— 那份是壳自己写的，绕一圈回来等于把壳的目录当成用户意图。
pub fn registry_origins() -> Vec<String> {
    if let Some(c) = kernel_choice() {
        if let Some(m) = c.manual {
            return vec![m];
        }
        if !c.origins.is_empty() {
            return c.origins;
        }
    }
    crate::mirror::load().npm
}

fn encode_pkg(pkg: &str) -> String {
    pkg.chars().map(|c| if c == '/' { "%2F".to_string() } else { c.to_string() }).collect()
}

/// 并行因镜像同步有延迟：首个成功即采信会把新版本掩盖成旧版本。每个源各自走完整通道决策，绝不跨源拼接 dist-tags；全部源失败时原样回传每个源的失败原因（不静默、不谎报「已是最新」）。
pub fn latest_pick(pkg: &str) -> Result<LatestPick, String> {
    if pkg.is_empty() { return Err("包名为空".into()); }
    let path = encode_pkg(pkg);
    let origins = registry_origins();
    let probes = crate::mirror::probe_all(&origins, &path);

    let canary = canary_here();

    let mut cands: Vec<Candidate> = Vec::new();
    let mut reachable = 0usize;
    for p in &probes {
        if !p.ok { continue; }
        reachable += 1;
        let Some(body) = &p.body else { continue };
        let Ok(j) = serde_json::from_str::<Value>(body) else { continue };
        let Ok(pick) = crate::release_channel::select(&j, canary) else { continue };
        cands.push((pick.version, p.latency_ms, p.source.clone(), pick.via));
    }

    match pick_best(cands) {
        Some((version, _, source, via)) => Ok(LatestPick { version, origin: source, via: via.to_string() }),
        None => {
            let detail = probes
                .iter()
                .map(|p| format!("{}:{}", p.source, if p.ok { format!("{}ms", p.latency_ms) } else { "不可达".into() }))
                .collect::<Vec<_>>()
                .join(", ");
            Err(format!("全部镜像不可用或均无该包（可达 {} 个；{}）", reachable, detail))
        }
    }
}

/// via 必须带回上层：rollback 生效时目标版本低于当前版本，只看版本比较会把回退判成「无需动手」—— 通道是识别回退的唯一可靠依据。
pub struct LatestPick {
    pub version: String,
    pub origin: String,
    pub via: String,
}

pub fn latest_version(pkg: &str) -> Result<(String, String), String> {
    latest_pick(pkg).map(|p| (p.version, p.origin))
}

type Candidate = (String, u128, String, &'static str);

/// 候选仲裁优先级：1) 通道（rollback > canary > latest > versions，契约的步序而非数字大小，必须压过版本比较）；2) 同通道内版本更高者胜（解决镜像同步滞后）；3) 版本相同延迟更低者胜。
fn better_candidate(a: &Candidate, b: &Candidate) -> bool {
    let (av, alat, _, avia) = a;
    let (bv, blat, _, bvia) = b;
    match channel_rank(avia).cmp(&channel_rank(bvia)) {
        std::cmp::Ordering::Less => true,
        std::cmp::Ordering::Greater => false,
        std::cmp::Ordering::Equal => {
            let c = semver_cmp(av, bv);
            c > 0 || (c == 0 && *alat < *blat)
        }
    }
}

fn pick_best(cands: Vec<Candidate>) -> Option<Candidate> {
    let mut best: Option<Candidate> = None;
    for c in cands {
        match &best {
            Some(b) if !better_candidate(&c, b) => {}
            _ => best = Some(c),
        }
    }
    best
}

/// 通道优先级（数值越小越优先）的顺序来自发布通道契约，不是版本高低：若退回比版本号，回退目标（低于 latest）会被别的源的 latest 压过去。
fn channel_rank(via: &str) -> u8 {
    match via {
        crate::release_channel::CH_ROLLBACK => 0,
        crate::release_channel::CH_CANARY => 1,
        crate::release_channel::CH_LATEST => 2,
        _ => 3,
    }
}

/// 灰度名单短路口径：1) 本机标记 canary（或环境变量）即命中，不查包；2) 未标记且未 opt-in 直接 false，零额外请求；3) 只有显式 opt-in 才读名单包（多一次请求，在探测循环之外，不随镜像数量放大）。
fn canary_here() -> bool {
    let local = crate::release_channel::local_canary_hit();
    let opt_in = crate::release_channel::allowlist_opt_in();
    if !local && !opt_in {
        return false;
    }
    let origins = registry_origins();
    crate::release_channel::canary_machine(local, opt_in, move |pkg| fetch_pkg_meta(&origins, pkg))
}

/// 复用 probe_all 的**单源**而非整个并行：并行测速要打通全部源，这里只是可选查询，打满全部源会把成本放大 N 倍；也不另写 HTTP，避免成为第二份 registry 客户端。
fn fetch_pkg_meta(origins: &[String], pkg: &str) -> Result<Value, String> {
    let path = encode_pkg(pkg);
    let mut last = String::from("无可用镜像");
    for o in origins {
        let one = std::slice::from_ref(o);
        match crate::mirror::probe_all(one, &path).into_iter().next() {
            Some(p) if p.ok => match p.body.as_deref() {
                Some(body) => match serde_json::from_str::<Value>(body) {
                    Ok(j) => return Ok(j),
                    Err(_) => last = format!("{}: 响应不是合法 JSON", o),
                },
                None => last = format!("{}: 空响应", o),
            },
            Some(_) => last = format!("{}: 不可达", o),
            None => last = format!("{}: 探测未返回", o),
        }
    }
    Err(last)
}

pub fn locate_core_for_cli() -> Option<std::path::PathBuf> {
    crate::domain::coreloc::locate_core_candidates(None)
        .into_iter()
        .find(|p| p.is_file())
}

fn package_dir_of(bin: &Path) -> Option<PathBuf> {
    let bin_dir = bin.parent()?;
    if bin_dir.file_name().and_then(|s| s.to_str()) != Some("bin") { return None; }
    bin_dir.parent().map(|p| p.to_path_buf())
}

pub fn installed_version(bin: &Path) -> Option<String> {
    if let Some(dir) = package_dir_of(bin) {
        if let Ok(s) = std::fs::read_to_string(dir.join("package.json")) {
            if let Ok(v) = serde_json::from_str::<Value>(&s) {
                if let Some(ver) = v.get("version").and_then(|x| x.as_str()) {
                    if is_valid_version(ver) { return Some(ver.to_string()); }
                }
            }
        }
    }
        // 兜底执行 --version 必须有界：候选不可执行（损坏 shim/拦截/架构不符）时，无限阻塞会让引导页永久停在「正在检查内核版本」（locate_core 对每个候选都调一次）。
    let mut cmd = std::process::Command::new(bin);
    cmd.arg("--version");
    match run_command_bounded(cmd, VERSION_PROBE_TIMEOUT, None) {
        Ok(o) if o.success => parse_version_output(&o.stdout),
        _ => None,
    }
}

const VERSION_PROBE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

pub fn parse_version_output(s: &str) -> Option<String> {
    for tok in s.split_whitespace() {
        let t = tok.trim().trim_start_matches('v');
        if is_valid_version(t) { return Some(t.to_string()); }
    }
    None
}

/// 用途仅限安装完成后回读 npm 把包装到了哪（记录 core.json）；不得用它选择安装前缀（选择用 global_prefix_for：内核位置与 prefix -g 可能不一致）。
pub fn npm_global_prefix() -> Option<PathBuf> {
    let rt = crate::runtime_contract::read_node()?;
    crate::runtime_contract::run_npm_line(&rt.npm, &rt.npm_prefix, &["prefix", "-g"])
        .ok()
        .map(|line| PathBuf::from(line.trim()))
}

/// 从内核真实路径反推 npm 全局前缀：Unix `<prefix>/lib/node_modules/@scope/pkg/bin/exe`、Windows `<prefix>/node_modules/@scope/pkg/bin/exe` -> `<prefix>`。
pub fn global_prefix_for(bin: &Path) -> Option<PathBuf> {
    let comps: Vec<std::path::Component> = bin.components().collect();
    for i in 0..comps.len() {
        if comps[i].as_os_str() == std::ffi::OsStr::new("node_modules") {
            let is_lib = i >= 1 && comps[i - 1].as_os_str() == std::ffi::OsStr::new("lib");
            let cut = if is_lib { i - 1 } else { i };
            let mut p = PathBuf::new();
            for c in &comps[..cut] { p.push(c.as_os_str()); }
            if p.as_os_str().is_empty() { return None; }
            return Some(crate::platform::external_path(&p));
        }
    }
        // Windows npm 垫片兜底：路径形如 `%APPDATA%\npm\dsh-supervisor.cmd`，不含 node_modules 段 —— 上面的循环会返回 None、install_version 丢失 --prefix，可能装错前缀。判据：该目录直接含 node_modules 时它就是全局前缀。
    if let Some(dir) = bin.parent() {
        if dir.join("node_modules").is_dir() {
            return Some(crate::platform::external_path(dir));
        }
    }
    None
}

fn tail(s: &str, n: usize) -> String {
    let t = s.trim();
    if t.chars().count() <= n { return t.to_string(); }
    t.chars().skip(t.chars().count() - n).collect()
}

/// 显式 --prefix 保证装回内核当前所在前缀，避免默认前缀不一致导致旧内核遮蔽新内核。
pub fn install_version(
    pkg: &str,
    version: &str,
    prefix: Option<&Path>,
    registry: Option<&str>,
    on_live: Option<&dyn Fn(&crate::bounded::Live)>,
) -> Result<String, String> {
    if !is_valid_version(version) { return Err(format!("非法目标版本: {}", version)); }
    install_spec(&format!("{}@{}", pkg, version), prefix, registry, on_live)
}

/// 装一个 npm 可接受的 spec（`pkg@version` 或本地 tarball 路径）—— 两种来源共用同一套快失败重试与证据组织；写成两份就会出现「远程装有缓存隔离重试、本地装没有」。
fn install_spec(
    spec: &str,
    prefix: Option<&Path>,
    registry: Option<&str>,
    on_live: Option<&dyn Fn(&crate::bounded::Live)>,
) -> Result<String, String> {
    let t0 = std::time::Instant::now();
    let first = run_npm_install(&spec, prefix, registry, None, on_live);
    match &first {
        Ok(out) if out.success => return Ok(tail(&out.stdout, 500)),
        Err(_) => {}
        Ok(_) => {}
    }
    let first_out = first.as_ref().ok();

    let mut second: Option<crate::bounded::ExecRecord> = None;
    if first_out.is_some() && t0.elapsed() <= FAST_FAIL_RETRY {
        if let Some(dir) = fresh_cache_dir() {
            let s = run_npm_install(&spec, prefix, registry, Some(&dir), on_live);
            let ok = matches!(&s, Ok(o) if o.success);
            if !ok { second = s.ok(); }
            let _ = std::fs::remove_dir_all(&dir);
            if ok {
                return Ok("（默认缓存首次失败，改用隔离缓存重试后成功）"
                    .to_string()
                    + &tail(first_out.map(|o| o.stdout.as_str()).unwrap_or(""), 200));
            }
        }
    }

    let mut ev = String::new();
    ev.push_str(&format!("cmd: {} install -g --no-audit --no-fund {}", npm_exe(), spec));
    if let Some(p) = prefix { ev.push_str(&format!(" --prefix {}", crate::platform::external_path(p).display())); }
    if let Some(r) = registry { if !r.is_empty() { ev.push_str(&format!(" [registry {}]", r)); } }
        // 失败正文一律由 `ExecRecord::failure` 渲染（退出状态与**实际**程序+参数都在记录里）：npm 常以 `node <npm-cli.js>` 形态被拉起，与逻辑 `cmd:` 并列时的不一致本身就是现场证据。
    let fmt = |o: &crate::bounded::ExecRecord| o.failure("npm install");
    match (first_out, second.as_ref()) {
        (Some(a), Some(b)) => Err(format!("{}；缓存隔离重试仍失败：{}", fmt(a), fmt(b))),
        (Some(a), None) => Err(format!("{}{}", fmt(a), FAST_SKIP_NOTE)),
        _ => Err(first.err().unwrap_or_else(|| "npm 未能启动".into())),
    }
    .map_err(|e| format!("{}\n  [{}]", e, ev))
}

/// 装一个已取到本地的包（tarball 路径）：与远程 spec 走同一条重试/证据路径，唯一区别是 npm 不再自己去 registry 取件 —— 只有这一步才有真字节数可报，故内核下载进度必须走这里。
pub fn install_local(
    tgz: &Path,
    prefix: Option<&Path>,
    registry: Option<&str>,
    on_live: Option<&dyn Fn(&crate::bounded::Live)>,
) -> Result<String, String> {
    install_spec(&file_spec(tgz), prefix, registry, on_live)
}

/// 本地包必须写成 `file:` 形态：裸绝对路径在 npm 的 spec 解析里是否算「文件」并无保证（Windows 的 `C:\...` 会被先当作包名候选），而那会让整次安装静默打到 registry。
fn file_spec(tgz: &Path) -> String {
    format!("file:{}", tgz.display())
}

pub struct DistInfo {
    pub tarball: String,
    pub size: Option<u64>,
        /// `dist.integrity` 只认 `sha512-<base64>`（算法不符或长度不对一律当没有，不拿别的摘要凑数）：解出的原始摘要用于核对，缺失即 None（只按字节数核对）。
    pub sha512: Option<Vec<u8>>,
}

fn parse_integrity(v: Option<&Value>) -> Option<Vec<u8>> {
    let (alg, b64) = v?.as_str()?.split_once('-')?;
    if alg != "sha512" { return None; }
    use base64::Engine;
    base64::engine::general_purpose::STANDARD
        .decode(b64)
        .ok()
        .filter(|d| d.len() == 64)
}

/// 从**指定单个源**读 `<pkg>@<version>` 的 dist 信息：逐源尝试时元数据必须与包同源，跨源拼接会让 A 源的摘要去核 B 源的字节。
pub fn dist_from(pkg: &str, version: &str, origin: &str) -> Result<DistInfo, String> {
    if !is_valid_version(version) { return Err(format!("非法目标版本: {}", version)); }
    let meta = fetch_pkg_meta(&[origin.to_string()], pkg)?;
    let dist = meta
        .get("versions")
        .and_then(|v| v.get(version))
        .and_then(|v| v.get("dist"))
        .ok_or_else(|| format!("{} 上没有 {}@{} 的 dist 元数据", origin, pkg, version))?;
    let tarball = dist
        .get("tarball")
        .and_then(|x| x.as_str())
        .ok_or_else(|| format!("{} 上没有 {}@{} 的 dist.tarball", origin, pkg, version))?;
        // 判据在 mirror::asset_url（形态 + 主机维度）：这个主机是 registry 替我们选的，与跨主机跳转同一性质，所以它必须自己过私网闸，而不是「看着像 http 就行」。
    let target = crate::mirror::asset_url(tarball)
        .map_err(|e| format!("{} 的 dist.tarball 非法：{}（{}）", origin, e, tarball))?;
    Ok(DistInfo {
        tarball: target,
        size: dist.get("size").and_then(|x| x.as_u64()).filter(|t| *t > 0),
        sha512: parse_integrity(dist.get("integrity")),
    })
}

/// 包内落点名：包名带 scope 与 `/`（`@lob-ox/dsh-core-linux-x64`），必须先归一才准进路径 —— 否则一个来自 registry 的字符串就成了目录穿越的入口。
fn dist_slug(s: &str) -> String {
    s.chars()
        .map(|c| if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') { c } else { '_' })
        .collect()
}

pub fn dist_cache_path(pkg: &str, version: &str) -> PathBuf {
    crate::env::supervisor_dir()
        .join("dl")
        .join(format!("{}-{}.tgz", dist_slug(pkg), dist_slug(version)))
}

/// 取回 tarball 并按该源自己声明的元数据核对（返回 字节数, 是否核过摘要）：摘要与元数据出自同一信任根，故挡的是截断与镜像上的损坏文件（与 npm 自身同强度），不是「防注册表作恶」—— 那层只有签名发布链能给。
pub fn fetch_dist(
    dist: &DistInfo,
    dst: &Path,
    on_bytes: &dyn Fn(u64, Option<u64>),
) -> Result<(u64, bool), String> {
    use sha2::{Digest, Sha512};
    let data = crate::node::http_get_bytes_progress(&dist.tarball, dist.size, Some(on_bytes))?;
    if let Some(t) = dist.size {
        if data.len() as u64 != t {
            return Err(format!("取回不完整：该源声明 {} 字节，实得 {} 字节", t, data.len()));
        }
    }
    if let Some(want) = &dist.sha512 {
        if hex::encode(Sha512::digest(&data)) != hex::encode(want) {
            return Err("SHA512 校验失败（该源的包内容与其元数据不符，拒绝安装）".to_string());
        }
    }
    if let Some(parent) = dst.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建 {} 失败: {}", parent.display(), e))?;
    }
    std::fs::write(dst, &data).map_err(|e| format!("写入 {} 失败: {}", dst.display(), e))?;
    Ok((data.len() as u64, dist.sha512.is_some()))
}


/// prefix 是否为 Node 安装目录（含 node_modules/npm）：只回传证据、不擅自丢弃 prefix —— 丢弃可能装到别的前缀，反而制造「装了但检测不到」。
pub fn is_node_install_prefix(p: &Path) -> bool {
    p.join("node_modules").join("npm").is_dir()
}
/// 缓存隔离重试窗口：首次失败耗时不超过此值才重试（避免突破引导页 17 分钟预算）。
const FAST_FAIL_RETRY: std::time::Duration = std::time::Duration::from_secs(120);
const FAST_SKIP_NOTE: &str = "（首次失败耗时较长，未做缓存隔离重试）";

fn fresh_cache_dir() -> Option<std::path::PathBuf> {
    let d = std::env::temp_dir().join(format!("dsh-npmcache-{}", std::process::id()));
    std::fs::create_dir_all(&d).ok()?;
    Some(d)
}

fn run_npm_install(
    spec: &str,
    prefix: Option<&Path>,
    registry: Option<&str>,
    cache: Option<&Path>,
    on_live: Option<&dyn Fn(&crate::bounded::Live)>,
) -> Result<crate::bounded::ExecRecord, String> {
        // 单一事实源：优先用运行期契约里的**绝对 npm** 与 PATH（不依赖 ambient PATH 的裸名）—— GUI/服务环境的 PATH 常不含 nvm/fnm 的 npm。
    let (npm_bin, npm_prefix, env_path) = match crate::runtime_contract::read_node() {
        Some(rt) if rt.npm.is_file() => (
            rt.npm,
            rt.npm_prefix,
            Some(crate::runtime_contract::env_path(&rt.node_bin_dir)),
        ),
        _ => (std::path::PathBuf::from(npm_exe()), Vec::new(), None),
    };
    let mut cmd = std::process::Command::new(&npm_bin);
    if let Some(p) = &env_path {
        cmd.env("PATH", p);
    }
    cmd.args(&npm_prefix);
    cmd.args(["install", "-g", "--no-audit", "--no-fund"]).arg(spec);
    if let Some(p) = prefix { cmd.arg("--prefix").arg(crate::platform::external_path(p)); }
    if let Some(r) = registry { if !r.is_empty() { cmd.env("npm_config_registry", r); } }
    if let Some(c) = cache { cmd.env("npm_config_cache", c); }
    crate::bounded::prepare(&mut cmd);
    run_command_bounded(cmd, NPM_INSTALL_TIMEOUT, on_live)
}
/// npm install 的时间上限：慢网下确实可能数分钟，故给足；但绝不无限等待 —— 超时即杀进程并如实报错。`pub(crate)`：开工行的「单源上限 N 分钟」措辞由 `domain::install` **从本常量算出**（手写数字会改一处即失配）。
pub(crate) const NPM_INSTALL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15 * 60);

/// npm install 的**心跳节奏**：再密只是重复同一句话（每次都要过 IPC 与 DOM），再疏则「看起来又卡住了」；2s 与守卫看门的 tick 同量级，且远小于人的耐心阈值。
const NPM_HEARTBEAT: std::time::Duration = std::time::Duration::from_secs(2);

/// 有界执行子进程 —— 委托 `bounded.rs` 的统一实现（stdin/prepare/超时杀进程都在那里），返回 `bounded::ExecRecord`；on_live 为 Some 时走 run_watch 提供心跳。
fn run_command_bounded(
    mut cmd: std::process::Command,
    timeout: std::time::Duration,
    on_live: Option<&dyn Fn(&crate::bounded::Live)>,
) -> Result<crate::bounded::ExecRecord, String> {
    match on_live {
        Some(cb) => crate::bounded::run_watch(&mut cmd, timeout, NPM_HEARTBEAT, cb),
        None => crate::bounded::run(&mut cmd, timeout),
    }
}


/// 规划：正常路径只有目标严格大于已装才需动手；回退（via=rollback）时目标更低仍判需动手 —— 纯版本比较认不出回退。`core_apply` 不做版本比较，升级/回退共用同一执行路径（前端只有 install/upgrade，刻意如此）。
pub fn build_plan(installed: Option<String>, latest: Result<LatestPick, String>) -> Value {
    let (latest_v, origin, err, via) = match latest {
        Ok(p) => (Some(p.version), Some(p.origin), None, Some(p.via)),
        Err(e) => (None, None, Some(e), None),
    };
    let is_rollback = via.as_deref() == Some("rollback");
    let action = match (&installed, &latest_v) {
        (None, Some(_)) => "install",
        (Some(i), Some(l)) => {
            let cmp = semver_cmp(l, i);
            if cmp > 0 { "upgrade" }
            else if is_rollback && cmp != 0 { "upgrade" }
            else { "none" }
        }
        _ => "unknown",
    };
    let origin_out = origin.clone();
    let mut extra = serde_json::Map::new();
    extra.insert("installed".into(), serde_json::json!(installed.clone()));
    extra.insert("action".into(), serde_json::json!(action));
    extra.insert("updateAvailable".into(), serde_json::json!(action == "upgrade"));
    extra.insert("registry".into(), serde_json::json!(origin));
    extra.insert("latestVia".into(), serde_json::json!(via));
    extra.insert("isRollback".into(), serde_json::json!(is_rollback));
    crate::update_plan::unified(
        "kernel",
        installed,
        latest_v,
        action == "upgrade" || action == "install",
        origin_out,
        err,
        extra,
    )
}

pub fn plan_text() -> String {
    let pkg = match package_name() { Ok(p) => p, Err(e) => return format!("pkg_error={}", e) };
    let mut lines = vec![format!("package={}", pkg)];
    lines.push(format!("origins={}", registry_origins().join(",")));
    match latest_version(&pkg) {
        Ok((v, o)) => {
            lines.push(format!("latest={}", v));
            lines.push(format!("latest_origin={}", o));
            lines.push(format!("latest_via={}", decision_channel(&pkg)));
        }
        Err(e) => lines.push(format!("latest_error={}", e)),
    }
    lines.join(" | ")
}

fn decision_channel(pkg: &str) -> String {
    let path = encode_pkg(pkg);
    let origins = registry_origins();
    let probes = crate::mirror::probe_all(&origins, &path);
    let canary = canary_here();
    let mut cands: Vec<Candidate> = Vec::new();
    for p in &probes {
        if !p.ok { continue; }
        let Some(body) = &p.body else { continue };
        let Ok(j) = serde_json::from_str::<Value>(body) else { continue };
        if let Ok(pick) = crate::release_channel::select(&j, canary) {
            cands.push((pick.version, p.latency_ms, p.source.clone(), pick.via));
        }
    }
    pick_best(cands).map(|c| c.3.to_string()).unwrap_or_else(|| "unknown".into())
}
#[cfg(test)]
mod tests {
    use super::*;

        /// 跨语言无法共享代码，故共享行为规格 `shell-release/version-vectors.json`（内核仓有逐字节相同的一份）：单侧改语义而没同步则本测试失败。include_str! 编译期嵌入：文件缺失直接编译失败，强于运行时读取的静默跳过。
    const VECTORS: &str = include_str!("../../shell-release/version-vectors.json");

    fn str_field(body: &str, key: &str) -> Option<String> {
        let pat = format!("\"{}\":", key);
        let after = body.split(&pat).nth(1)?;
        let mut it = after.split('"');
        it.next()?;
        Some(it.next()?.to_string())
    }

    fn bool_field(body: &str, key: &str) -> Option<bool> {
        let pat = format!("\"{}\":", key);
        let after = body.split(&pat).nth(1)?;
        let v = after.trim_start();
        if v.starts_with("true") { Some(true) } else { Some(false) }
    }

    fn dist_meta(json: &str) -> Value {
        let v: Value = serde_json::from_str(json).expect("测试内 JSON 必须合法");
        v["versions"]["0.1.6-BETA.3"]["dist"].clone()
    }

    #[test]
    fn integrity_only_accepts_a_64_byte_sha512() {
        let b64 = {
            use base64::Engine;
            base64::engine::general_purpose::STANDARD.encode([7u8; 64])
        };
        let ok = dist_meta(&format!(
            r#"{{"versions":{{"0.1.6-BETA.3":{{"dist":{{"integrity":"sha512-{b64}"}}}}}}}}"#
        ));
        assert_eq!(parse_integrity(ok.get("integrity")).map(|v| v.len()), Some(64));
        for bad in ["sha1-abc", "!!!", "sha512-YQ=="] {
            let d = dist_meta(&format!(
                r#"{{"versions":{{"0.1.6-BETA.3":{{"dist":{{"integrity":"{bad}"}}}}}}}}"#
            ));
            assert_eq!(parse_integrity(d.get("integrity")), None, "{bad} 不该被当成校验值");
        }
        assert_eq!(parse_integrity(None), None);
    }

    #[test]
    fn dist_slug_leaves_no_path_separators_or_dots() {
        let s = dist_slug("@lob-ox/dsh-core-win-x64");
        assert_eq!(s, "_lob-ox_dsh-core-win-x64", "scope 里的 / 必须被换掉：{s}");
        for evil in ["../../../etc/passwd", "a\\b", "..", ""] {
            let out = dist_slug(evil);
            assert!(!out.contains('/') && !out.contains('\\'), "{evil} 归一后仍带分隔符: {out}");
            assert!(out.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-')));
        }
    }

    #[test]
    fn local_spec_uses_the_file_protocol() {
        let p = std::path::Path::new("/tmp/dl/pkg.tgz");
        assert_eq!(file_spec(p), "file:/tmp/dl/pkg.tgz");
    }

    fn int_field(body: &str, key: &str) -> Option<i32> {
        let pat = format!("\"{}\":", key);
        let after = body.split(&pat).nth(1)?;
        let digits: String = after.trim_start()
            .chars()
            .take_while(|c| c.is_ascii_digit() || *c == '-')
            .collect();
        digits.parse().ok()
    }

    fn object_bodies(raw: &str) -> Vec<String> {
        let mut all = Vec::new();
        let mut stack: Vec<usize> = Vec::new();
        for (i, c) in raw.char_indices() {
            match c {
                '{' => stack.push(i),
                '}' => {
                    if let Some(s) = stack.pop() {
                        all.push(raw[s..=i].to_string());
                    }
                }
                _ => {}
            }
        }
        let limit = raw.len() / 2;
        all.into_iter().filter(|b| b.len() < limit).collect()
    }

    #[test]
    fn shared_version_vectors_hold() {
        let bodies = object_bodies(VECTORS);
        assert!(
            bodies.len() >= 20,
            "向量块数异常：{}（模板可能被破坏）",
            bodies.len()
        );

        let (mut nv, mut nc) = (0, 0);
        for b in &bodies {
            if b.contains("\"input\"") {
                let input = str_field(b, "input").expect("input 缺失");
                let valid = bool_field(b, "valid").expect("valid 缺失");
                let got = is_valid_version(&input);
                assert_eq!(
                    got, valid,
                    "版本合法性分歧：{:?} → 本实现 {}，向量期望 {}",
                    input, got, valid
                );
                nv += 1;
            } else if b.contains("\"expected\"") {
                let a = str_field(b, "a").expect("a 缺失");
                let bq = str_field(b, "b").expect("b 缺失");
                let exp = int_field(b, "expected").expect("expected 缺失");
                let got = semver_cmp(&a, &bq);
                assert_eq!(
                    got, exp,
                    "版本比较分歧：{:?} vs {:?} → 本实现 {}，向量期望 {}",
                    a, bq, got, exp
                );
                nc += 1;
            }
        }
        assert!(nv >= 15, "合法性向量过少：{}", nv);
        assert!(nc >= 8, "比较向量过少：{}", nc);
        eprintln!("版本向量通过：合法性 {} 条 / 比较 {} 条", nv, nc);
    }


    use crate::release_channel::{CH_CANARY, CH_LATEST, CH_ROLLBACK, CH_VERSIONS};

    fn cand(v: &str, lat: u128, src: &str, via: &'static str) -> Candidate {
        (v.to_string(), lat, src.to_string(), via)
    }

    #[test]
    fn pick_best_prefers_higher_version_within_same_channel() {
        let got = pick_best(vec![
            cand("0.1.5-BETA.3", 10, "fast", CH_LATEST),
            cand("0.1.5-BETA.7", 500, "slow", CH_LATEST),
        ])
        .unwrap();
        assert_eq!(got.0, "0.1.5-BETA.7");
        assert_eq!(got.2, "slow", "更高版本胜出，即使它更慢");
    }

    #[test]
    fn pick_best_prefers_lower_latency_on_tie() {
        let got = pick_best(vec![
            cand("0.1.5", 900, "slow", CH_LATEST),
            cand("0.1.5", 12, "fast", CH_LATEST),
        ])
        .unwrap();
        assert_eq!(got.2, "fast", "同版本时保留更快源");
    }

    #[test]
    fn pick_best_rollback_beats_other_sources_latest() {
        let got = pick_best(vec![
            cand("0.2.0", 5, "synced-latest", CH_LATEST),
            cand("0.1.4", 800, "synced-rollback", CH_ROLLBACK),
        ])
        .unwrap();
        assert_eq!(got.0, "0.1.4");
        assert_eq!(got.3, CH_ROLLBACK);
    }

    #[test]
    fn channel_priority_is_rollback_canary_latest_versions() {
        assert!(channel_rank(CH_ROLLBACK) < channel_rank(CH_CANARY));
        assert!(channel_rank(CH_CANARY) < channel_rank(CH_LATEST));
        assert!(channel_rank(CH_LATEST) < channel_rank(CH_VERSIONS));
        let got = pick_best(vec![
            cand("0.9.9", 1, "a", CH_LATEST),
            cand("0.1.6-BETA.1", 900, "b", CH_CANARY),
        ])
        .unwrap();
        assert_eq!(got.3, CH_CANARY);
    }

    #[test]
    fn pick_best_rejects_old_highest_of_all_form() {
        let meta = serde_json::json!({
            "dist-tags": { "latest": "0.1.5-BETA.3" },
            "versions": { "0.1.5-BETA.3": {}, "1.0.0-BETA.1": {} },
        });
        let picked = crate::release_channel::select(&meta, false).unwrap();
        assert_eq!(picked.version, "0.1.5-BETA.3");
        let old_would_pick = "1.0.0-BETA.1";
        assert_ne!(picked.version, old_would_pick, "RC-G5 反向自检失败");
    }

    #[test]
    fn pick_best_empty_is_none() {
        assert!(pick_best(vec![]).is_none(), "无候选必须返回 None（由调用方如实报错，RC-5）");
    }


    fn pick(v: &str, via: &'static str) -> Result<LatestPick, String> {
        Ok(LatestPick { version: v.to_string(), origin: "test".into(), via: via.to_string() })
    }

    #[test]
    fn rollback_lower_version_still_triggers_action() {
        let p = build_plan(Some("0.1.5".into()), pick("0.1.4", "rollback"));
        assert_eq!(p["action"], "upgrade", "回退目标更低时必须触发（否则 RC-2 端到端断裂）");
        assert_eq!(p["available"], true);
        assert_eq!(p["isRollback"], true);
        assert_eq!(p["latestVia"], "rollback");
        assert_eq!(p["latest"], "0.1.4");
    }

    #[test]
    fn same_version_via_rollback_is_noop() {
        let p = build_plan(Some("0.1.5".into()), pick("0.1.5", "rollback"));
        assert_eq!(p["action"], "none");
        assert_eq!(p["isRollback"], true);
    }

    #[test]
    fn non_rollback_lower_version_does_not_trigger() {
        let p = build_plan(Some("0.1.5".into()), pick("0.1.1-BETA.1", "latest"));
        assert_eq!(p["action"], "none", "陈旧 latest 不得被误判为回退");
        assert_eq!(p["isRollback"], false);
    }

    #[test]
    fn rollback_above_current_is_normal_upgrade() {
        let p = build_plan(Some("0.1.5".into()), pick("0.1.6", "rollback"));
        assert_eq!(p["action"], "upgrade");
        assert_eq!(p["isRollback"], true);
    }

    #[test]
    fn not_installed_via_rollback_is_install() {
        let p = build_plan(None, pick("0.1.4", "rollback"));
        assert_eq!(p["action"], "install");
    }
}
