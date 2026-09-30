// 内核（dsh-supervisor）版本治理：引导期的强制更新。
// 强制 = 目标高于本机就必须更新；不因版本比较而降级。
// 回退只走显式 dist-tags.rollback 通道；版本比较认不出回退，
// 故 latest_pick 把选版依据 via 下传给 build_plan（升级/回退共用同一执行路径）。

// 跨平台规范：包名按 os/arch 映射（@dsh-sup/dsh-core-<os>-<arch>）；
// npm 可执行名由 platform 层给出（Windows 为 npm.cmd）；
// 镜像顺序：内核选择文档 registry-choice.json（manual 用 manualOrigin，否则其候选），
// 该文档缺失时退回壳自持目录。

// 安装前缀从已定位内核的真实路径反推，绝不用 npm prefix -g：
// nvm/自定义 prefix 下两者可能与内核实际位置不一致，
// 直接装会把新内核装到别处、旧内核继续遮蔽（「更新了却没生效」）。

// 选版遵循发布通道契约（见 release_channel.rs）：优先信
// dist-tags.rollback / canary / latest，仅 latest 缺失时兜底取 versions 最高。
// 不得改回「跨源取全量最高」：那会绕过通道控制，BETA 的数字可能压过正式版。

use serde_json::Value;
use std::path::{Path, PathBuf};

/// 平台 -> npm 子包名（唯一真源；错误提示/安装/查询共用，杜绝散落硬编码）。
pub fn package_name() -> Result<String, String> {
    // 平台标签是**平台事实**，只在 platform 层解析（门禁 G1）；
    // 这里只负责拼包名，不得再出现 std::env::consts 的平台分支。
    let tag = crate::platform::current()
        .core_platform_tag()
        .ok_or_else(|| "当前平台/架构无对应的内核发布包".to_string())?;
    Ok(format!("@dsh-sup/dsh-core-{}", tag))
}

/// npm 可执行名（Windows 需 .cmd 后缀）—— 下沉到 trait（P2/G1）。
pub fn npm_exe() -> &'static str {
    crate::platform::current().npm_exe_name()
}

fn num_ok(s: &str) -> bool {
    if s.is_empty() { return false; }
    if s.len() > 1 && s.starts_with('0') { return false; } // 禁止前导零（对齐 semver）
    s.chars().all(|c| c.is_ascii_digit())
}

/// 版本字面量合法性：`X.Y.Z[-pre][+build]`，build 段须匹配 `[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*`。
/// 行为规格由 `shell-release/version-vectors.json` 锁定（内核侧同一份）——
/// 跨语言无法共享代码，但可共享行为规格，两侧测试都按它断言。
pub fn is_valid_version(v: &str) -> bool {
    let mut it = v.splitn(2, '+');
    let core = it.next().unwrap_or("");
    let build = it.next();

    // 主段 + 预发布段
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

    // build 段（不忽略）：非空，且每段为 [0-9A-Za-z-]+
    if let Some(b) = build {
        if b.is_empty() { return false; }
        for seg in b.split('.') {
            if seg.is_empty() || !seg.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') { return false; }
        }
    }
    true
}

/// semver 比较（与内核 semverCompare 同语义）：数值段优先；release > prerelease；
/// 预发布内「数字段 < 字符串段」；build metadata 不参与。返回 -1/0/1。
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
    if ap.is_empty() { return 1; }  // release > prerelease
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
                    return if xn { -1 } else { 1 }; // 数字段 < 字符串段
                } else if x != y {
                    return if x < y { -1 } else { 1 };
                }
            }
        }
    }
    0
}

/// 内核自持的镜像选择文档（`<产品状态根>/supervisor/registry-choice.json`，只有内核写）。
/// 壳读它只为一件事：用户在内核面板固定过源时，壳的安装/更新必须打在同一个源上。
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

/// 镜像候选集合，优先序与内核 policies.effectiveOrigins 一致：
/// 内核手动固定的源 > 内核里用户维护的候选 > 壳自持目录（mirror.rs 预设或其落盘覆盖）。
/// 不读壳投出的契约候选：那份是壳自己写的，绕一圈回来等于把壳的目录当成用户意图。
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

/// 包名 URL 编码：scope 的 / 编码为 %2F（npm registry 两种写法均可，编码更稳）。
fn encode_pkg(pkg: &str) -> String {
    pkg.chars().map(|c| if c == '/' { "%2F".to_string() } else { c.to_string() }).collect()
}

/// 目标版本：并行探测全部镜像，按发布通道契约选版；返回 (version, 命中镜像, via)。
/// 并行因镜像同步有延迟：首个成功即采信会把新版本掩盖成旧版本。
/// 每个源各自走完整通道决策，绝不跨源拼接 dist-tags（见 better_candidate）；
/// 全部源失败时原样回传每个源的失败原因（RC-5：不静默、不谎报「已是最新」）。
pub fn latest_pick(pkg: &str) -> Result<LatestPick, String> {
    if pkg.is_empty() { return Err("包名为空".into()); }
    let path = encode_pkg(pkg);
    let origins = registry_origins();
    let probes = crate::mirror::probe_all(&origins, &path);

    // 灰度判定只做一次（放进循环 = 每个源都查一次名单包）；普通机器零额外请求。
    let canary = canary_here();

    let mut cands: Vec<Candidate> = Vec::new();
    let mut reachable = 0usize;
    for p in &probes {
        if !p.ok { continue; }
        reachable += 1;
        let Some(body) = &p.body else { continue };
        let Ok(j) = serde_json::from_str::<Value>(body) else { continue };
        // 该源独立走完整通道决策 —— 一个源坏掉/缺 tag 不影响其它源的决策。
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

/// 选版结果 + 选版依据（通道）。
/// via 必须带回上层：rollback 生效时目标版本低于当前版本，
/// 只看版本比较会把回退判成「无需动手」；通道是识别回退的唯一可靠依据。
pub struct LatestPick {
    pub version: String,
    pub origin: String,
    /// rollback | canary | latest | versions（见 release_channel::select）
    pub via: String,
}

/// 兼容封装：只要「版本, 源」的调用方（诊断输出等）用这个；需要判回退的用 `latest_pick`。
pub fn latest_version(pkg: &str) -> Result<(String, String), String> {
    latest_pick(pkg).map(|p| (p.version, p.origin))
}

/// 一个镜像给出的候选：(版本, 延迟ms, 源, 通道)。
type Candidate = (String, u128, String, &'static str);

/// 候选 a 是否优于候选 b（跨源仲裁的唯一判据）。
/// 优先级：1) 通道（rollback > canary > latest > versions，契约的步序而非数字大小）；
/// 2) 同通道内版本更高者胜（解决镜像同步滞后）；3) 版本相同延迟更低者胜。
/// 通道必须压过版本比较：回退目标本就低于 latest，按数字仲裁会被别的源压过去（RC-2）。
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

/// 从全部候选里挑出唯一目标（纯函数 —— 跨源仲裁因此可被单元测试直接覆盖）。
///
/// 按输入顺序**一次遍历**：只有**严格更优**才替换，故并列时保留先到者
///   （`probe_all` 已按"可达优先 + 延迟升序"排好，先到即最快）。
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

/// 通道优先级（数值越小越优先）——顺序来自发布通道契约，不是版本高低。
/// 若退回比版本号，回退目标（低于 latest）会被别的源的 latest 压过去（RC-2）。
fn channel_rank(via: &str) -> u8 {
    match via {
        crate::release_channel::CH_ROLLBACK => 0,
        crate::release_channel::CH_CANARY => 1,
        crate::release_channel::CH_LATEST => 2,
        _ => 3, // versions 兜底
    }
}

/// 本机是否在灰度名单内（短路顺序见 `release_channel::canary_machine_with`）：
/// 1) 本机标记 canary（或环境变量）即命中，不查包；
/// 2) 未标记且未 opt-in 直接 false，零额外请求；
/// 3) 只有显式 opt-in 才读名单包（多一次请求，在探测循环之外，不随镜像数量放大）。
fn canary_here() -> bool {
    let local = crate::release_channel::local_canary_hit();
    // 普通机器在此直接返回 false：fetch 闭包不被调用，零额外网络请求。
    let opt_in = crate::release_channel::allowlist_opt_in();
    if !local && !opt_in {
        return false;
    }
    let origins = registry_origins();
    crate::release_channel::canary_machine(local, opt_in, move |pkg| fetch_pkg_meta(&origins, pkg))
}

/// 按镜像顺序串行取一份包元数据，首个成功即返回。
/// 复用 probe_all 的**单源**而非整个并行：并行测速要打通全部源，这里只是可选查询，
/// 打满全部源会把成本放大 N 倍；也不另写 HTTP，避免成为第二份 registry 客户端。
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

/// 无 GUI 场景下定位内核可执行文件（与 main.rs 的 locate_core 同一候选集）。
/// 供 --service-plan 等 CLI 自检使用：它们没有 AppHandle。
pub fn locate_core_for_cli() -> Option<std::path::PathBuf> {
    // CLI 无 AppHandle，不提供资源目录兜底（那是 GUI 形态的最后一层）
    crate::domain::coreloc::locate_core_candidates(None)
        .into_iter()
        .find(|p| p.is_file())
}

/// 内核包目录（<pkg>/bin/<exe> 反推 <pkg>）。
fn package_dir_of(bin: &Path) -> Option<PathBuf> {
    let bin_dir = bin.parent()?;              // <pkg>/bin
    if bin_dir.file_name().and_then(|s| s.to_str()) != Some("bin") { return None; }
    bin_dir.parent().map(|p| p.to_path_buf()) // <pkg>
}

/// 已安装版本：优先读包内 package.json（无进程开销、跨平台一致）；兜底执行 --version。
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
    // 兜底：执行 --version。必须有界：候选不可执行（损坏 shim/拦截/架构不符）时，
    //   无限阻塞会让引导页永久停在「正在检查内核版本」（locate_core 对每个候选都调一次）。
    let mut cmd = std::process::Command::new(bin);
    cmd.arg("--version");
    match run_command_bounded(cmd, VERSION_PROBE_TIMEOUT, None) {
        Ok(o) if o.success => parse_version_output(&o.stdout),
        _ => None,
    }
}

/// 内核 `--version` 探测的时间上限。
const VERSION_PROBE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

/// 从 --version 输出解析版本（形如 "dsh-supervisor v0.1.2-BETA.7"）。
pub fn parse_version_output(s: &str) -> Option<String> {
    for tok in s.split_whitespace() {
        let t = tok.trim().trim_start_matches('v');
        if is_valid_version(t) { return Some(t.to_string()); }
    }
    None
}

/// 读 npm 自己的全局 prefix（`<contract npm> prefix -g`）。
/// 用途仅限安装完成后回读 npm 把包装到了哪（记录 core.json）；
/// 不得用它选择安装前缀（选择用 global_prefix_for：内核位置与 prefix -g 可能不一致）。
pub fn npm_global_prefix() -> Option<PathBuf> {
    let rt = crate::runtime_contract::read_node()?;
    // 与 npm 可用性探针走同一条 spawn 路径（T-10）：程序与前置参数取自契约，只换尾参；
    //   自建 Command 会让「探针能跑、这里跑不起来」的缺陷只在一路上复现。
    crate::runtime_contract::run_npm_line(&rt.npm, &rt.npm_prefix, &["prefix", "-g"])
        .ok()
        .map(|line| PathBuf::from(line.trim()))
}

/// 从内核真实路径反推 npm 全局前缀（跨平台布局差异见下）。
///   Unix    : <prefix>/lib/node_modules/@scope/pkg/bin/exe  -> <prefix>
///   Windows : <prefix>/node_modules/@scope/pkg/bin/exe      -> <prefix>
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
    // Windows npm 垫片兜底：路径形如 `%APPDATA%\npm\dsh-supervisor.cmd`，不含 node_modules 段，
    //   上面的循环返回 None、install_version 丢失 --prefix，可能装错前缀（旧内核遮蔽新内核）。
    //   判据：该目录直接含 node_modules 时，它本身就是 npm 全局前缀。
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

/// 安装/升级到指定版本（npm install -g [--prefix] pkg@version）。
/// 显式 --prefix 保证装回内核当前所在前缀，避免默认前缀不一致导致旧内核遮蔽新内核。
/// 成功返回 npm 输出；失败回传完整证据（命令/prefix/源/两次尝试输出），不吞错。
/// 快失败窗口内用全新临时缓存重试一次；on_live 只交出事实，用户文案属 domain::install。
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

/// 装一个 npm 可接受的 spec（`pkg@version` 或本地 tarball 路径）——两种来源共用同一套
/// 快失败重试与证据组织；写成两份就会出现「远程装有缓存隔离重试、本地装没有」。
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
        Err(_) => {} // 连启动都失败（npm 不存在等）—— 直接回报，不重试
        Ok(_) => {}
    }
    let first_out = first.as_ref().ok();

    // 只在快失败窗口内做缓存隔离重试（避免突破引导页预算）
    let mut second: Option<crate::bounded::ExecRecord> = None;
    if first_out.is_some() && t0.elapsed() <= FAST_FAIL_RETRY {
        if let Some(dir) = fresh_cache_dir() {
            let s = run_npm_install(&spec, prefix, registry, Some(&dir), on_live);
            let ok = matches!(&s, Ok(o) if o.success);
            if !ok { second = s.ok(); }
            let _ = std::fs::remove_dir_all(&dir); // 尽力清理，失败不报错
            if ok {
                return Ok("（默认缓存首次失败，改用隔离缓存重试后成功）"
                    .to_string()
                    + &tail(first_out.map(|o| o.stdout.as_str()).unwrap_or(""), 200));
            }
        }
    }

    // 组织**完整证据**（现场定位所需：命令 / prefix / 源 / 两次输出）
    let mut ev = String::new();
    ev.push_str(&format!("cmd: {} install -g --no-audit --no-fund {}", npm_exe(), spec));
    // 证据里的 prefix = npm **实际收到**的那个值（run_npm_install 交出去前会归一）。
    //   报一个「我们内部推导用的」路径而执行的是另一个，等于把最有价值的线索藏起来。
    if let Some(p) = prefix { ev.push_str(&format!(" --prefix {}", crate::platform::external_path(p).display())); }
    if let Some(r) = registry { if !r.is_empty() { ev.push_str(&format!(" [registry {}]", r)); } }
    // 失败正文一律由 `ExecRecord::failure` 渲染：退出状态与**实际**程序+参数都在记录里。
    //   （npm 常以 `node <npm-cli.js>` 形态被拉起，与上面 `cmd:` 记录的**逻辑**命令
    //     并列呈现时，两者不一致本身就是现场要查的证据。）
    let fmt = |o: &crate::bounded::ExecRecord| o.failure("npm install");
    match (first_out, second.as_ref()) {
        (Some(a), Some(b)) => Err(format!("{}；缓存隔离重试仍失败：{}", fmt(a), fmt(b))),
        (Some(a), None) => Err(format!("{}{}", fmt(a), FAST_SKIP_NOTE)),
        _ => Err(first.err().unwrap_or_else(|| "npm 未能启动".into())),
    }
    .map_err(|e| format!("{}\n  [{}]", e, ev))
}

/// 装一个已取到本地的包（tarball 路径）。与远程 spec 走同一条重试/证据路径，唯一区别是
/// npm 不再自己去 registry 取件 —— 只有这一步才有真字节数可报，故内核下载进度必须走这里。
pub fn install_local(
    tgz: &Path,
    prefix: Option<&Path>,
    registry: Option<&str>,
    on_live: Option<&dyn Fn(&crate::bounded::Live)>,
) -> Result<String, String> {
    install_spec(&file_spec(tgz), prefix, registry, on_live)
}

/// 本地包必须写成 `file:` 形态：裸绝对路径在 npm 的 spec 解析里是否算「文件」并无保证
/// （Windows 的 `C:\...` 会被先当作包名候选），而那会让整次安装静默打到 registry。
fn file_spec(tgz: &Path) -> String {
    format!("file:{}", tgz.display())
}

/// registry 里某个**具体版本**的取件信息（`versions[v].dist`）。
pub struct DistInfo {
    /// tarball 的绝对 URL —— 由该源自己给出，不拼路径：镜像的包路径规则不统一。
    pub tarball: String,
    /// 声明的字节数：进度分母，也是截断判据。源没给就是 None，进度行退回「已取回 N MB」。
    pub size: Option<u64>,
    /// `integrity: "sha512-<base64>"` 解出的原始摘要；缺失即为 None（只按字节数核对）。
    pub sha512: Option<Vec<u8>>,
}

/// `dist.integrity` 只认 `sha512-<base64>`；算法不符或长度不对一律当没有，不拿别的摘要凑。
fn parse_integrity(v: Option<&Value>) -> Option<Vec<u8>> {
    let (alg, b64) = v?.as_str()?.split_once('-')?;
    if alg != "sha512" { return None; }
    use base64::Engine;
    base64::engine::general_purpose::STANDARD
        .decode(b64)
        .ok()
        .filter(|d| d.len() == 64)
}

/// 从**指定单个源**读 `<pkg>@<version>` 的 dist 信息。
/// 逐源尝试时元数据必须与包同源：跨源拼接会让 A 源的摘要去核 B 源的字节。
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
    // 判据在 mirror::asset_url（形态 + 主机维度）：这个主机是 registry 替我们选的，
    // 与跨主机跳转同一性质，所以它必须自己过私网闸，而不是「看着像 http 就行」。
    let target = crate::mirror::asset_url(tarball)
        .map_err(|e| format!("{} 的 dist.tarball 非法：{}（{}）", origin, e, tarball))?;
    Ok(DistInfo {
        tarball: target,
        size: dist.get("size").and_then(|x| x.as_u64()).filter(|t| *t > 0),
        sha512: parse_integrity(dist.get("integrity")),
    })
}

/// 包内落点名：包名带 scope 与 `/`（`@dsh-sup/dsh-core-linux-x64`），必须先归一才准进路径，
/// 否则一个来自 registry 的字符串就成了目录穿越的入口。
fn dist_slug(s: &str) -> String {
    s.chars()
        .map(|c| if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') { c } else { '_' })
        .collect()
}

/// 内核包 tarball 的本地落点（与 Node 归档同一个 `dl/` 目录，形态一致便于排障）。
pub fn dist_cache_path(pkg: &str, version: &str) -> PathBuf {
    crate::env::supervisor_dir()
        .join("dl")
        .join(format!("{}-{}.tgz", dist_slug(pkg), dist_slug(version)))
}

/// 取回 tarball 并按该源自己声明的元数据核对，返回 `(字节数, 是否核过摘要)`。
/// 摘要与元数据出自同一信任根，所以它挡的是截断与镜像上的损坏文件（与 npm 自身同强度），
/// 不是「防注册表作恶」——那层只有签名发布链能给，本函数不冒充它。
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
        // 两边都转 hex 再比：`Output<Sha512>` 与 `Vec<u8>` 直接比需要额外的 trait 装配，
        // 而 `hex::encode` 走 AsRef<[u8]>，与本仓既有的 SHA256 校验点同一种写法。
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


/// prefix 是否为 Node 安装目录（含 node_modules/npm）。
/// 现场那条栈溢出无法本地复现，故只回传证据、不擅自丢弃 prefix：
/// 丢弃可能装到别的前缀，反而制造「装了但检测不到」。
pub fn is_node_install_prefix(p: &Path) -> bool {
    p.join("node_modules").join("npm").is_dir()
}
/// 缓存隔离重试窗口：首次失败耗时不超过此值才重试（避免突破引导页 17 分钟预算）。
const FAST_FAIL_RETRY: std::time::Duration = std::time::Duration::from_secs(120);
/// 未重试时的说明——让现场知道「为什么没有第二次尝试」。
const FAST_SKIP_NOTE: &str = "（首次失败耗时较长，未做缓存隔离重试）";

/// 构造一个**全新的**临时缓存目录（用于隔离损坏的 npm 缓存）。
fn fresh_cache_dir() -> Option<std::path::PathBuf> {
    let d = std::env::temp_dir().join(format!("dsh-npmcache-{}", std::process::id()));
    std::fs::create_dir_all(&d).ok()?;
    Some(d)
}

/// 执行一次 npm install（cache 为 Some 时使用隔离缓存）。
fn run_npm_install(
    spec: &str,
    prefix: Option<&Path>,
    registry: Option<&str>,
    cache: Option<&Path>,
    on_live: Option<&dyn Fn(&crate::bounded::Live)>,
) -> Result<crate::bounded::ExecRecord, String> {
    // 单一事实源：优先用运行期契约里的**绝对 npm** 与 PATH（不再依赖 ambient PATH 的裸名）。
    //   根因同守卫拉起：GUI/服务环境的 PATH 常不含 nvm/fnm 的 npm。
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
    // npm 仅有包内 JS 时：npmBin=node、npmPrefix=[npm-cli.js]（带上才能调用）。
    cmd.args(&npm_prefix);
    cmd.args(["install", "-g", "--no-audit", "--no-fund"]).arg(spec);
    if let Some(p) = prefix { cmd.arg("--prefix").arg(crate::platform::external_path(p)); }
    if let Some(r) = registry { if !r.is_empty() { cmd.env("npm_config_registry", r); } }
    if let Some(c) = cache { cmd.env("npm_config_cache", c); }
    // CREATE_NO_WINDOW：GUI 进程调 npm 不弹控制台。
    // 经 bounded::prepare（**infra 原语**，与 bounded::run 同一处实现）——
    // 本文件因此不再需要平台分支（门禁 G1）。
    crate::bounded::prepare(&mut cmd);
    // 必须有界：原实现用 `cmd.output()` 无限阻塞 —— npm 因网络停滞/registry 无响应挂起时，
    //   引导页会永久停在「正在安装内核…」。
    //   输出重定向到临时文件而非管道：不读取的管道被 npm 冗长输出填满（约 64KB）会死锁，
    //   临时文件无此问题，且便于超时后保留现场。
    run_command_bounded(cmd, NPM_INSTALL_TIMEOUT, on_live)
}
/// npm install 的时间上限。npm 在慢网下确实可能耗时数分钟，故给足预算；
/// 但绝不无限等待 —— 超时即杀进程并如实报错（引导页据此给出重试/回退）。
/// `pub(crate)`：开工行的「单源上限 N 分钟」措辞由 `domain::install` **从本常量算出**，
///   不再手写数字 —— 预算写进文案的第二处，改一处就会出现「说的是 15 分钟、干的是 20 分钟」。
pub(crate) const NPM_INSTALL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15 * 60);

/// npm install 的**心跳节奏**。取值权衡：再密只是重复同一句话（每次都要过 IPC 与 DOM），
/// 再疏则「看起来又卡住了」；2s 与守卫看门的 tick 同量级，且远小于人的耐心阈值。
const NPM_HEARTBEAT: std::time::Duration = std::time::Duration::from_secs(2);

/// 有界执行子进程 —— 委托给 `bounded.rs` 的统一实现。
/// 此处原有 `struct BoundedOutput` + `run_command_bounded` 的完整复制体，行为已分叉
/// （漏 stdin(null)、prepare 覆盖不全、临时名并发撞名）；现 stdin/prepare/超时杀进程
/// 统一走 `crate::bounded`，返回 `bounded::ExecRecord`；on_live 为 Some 时走 run_watch。
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


/// 计算规划：正常路径只有目标严格大于已装才需动手（不因版本比较而降级）。
/// 回退（via=rollback）时目标低于已装仍判需动手 —— 纯版本比较认不出回退，必须看通道信号。
/// `core_apply` 不做版本比较，升级/回退共用同一执行路径（前端只有 install/upgrade，刻意如此）。
pub fn build_plan(installed: Option<String>, latest: Result<LatestPick, String>) -> Value {
    let (latest_v, origin, err, via) = match latest {
        Ok(p) => (Some(p.version), Some(p.origin), None, Some(p.via)),
        Err(e) => (None, None, Some(e), None),
    };
    // 回退判定：通道 = rollback 且目标与已装不同即视为需动手（RC-2 端到端）。
    let is_rollback = via.as_deref() == Some("rollback");
    let action = match (&installed, &latest_v) {
        (None, Some(_)) => "install",
        (Some(i), Some(l)) => {
            let cmp = semver_cmp(l, i);
            if cmp > 0 { "upgrade" }
            else if is_rollback && cmp != 0 { "upgrade" }   // 回退：显式通道信号，非版本比较
            else { "none" }
        }
        _ => "unknown",
    };
    // 统一更新决策形状（与桌面自更新同一组键）；保留原字段向后兼容前端。
    let origin_out = origin.clone();
    let mut extra = serde_json::Map::new();
    extra.insert("installed".into(), serde_json::json!(installed.clone()));
    extra.insert("action".into(), serde_json::json!(action));
    extra.insert("updateAvailable".into(), serde_json::json!(action == "upgrade"));
    extra.insert("registry".into(), serde_json::json!(origin));
    // 选版依据（rollback/canary/latest/versions）——前端与运维据此识别"当前是否回退中"。
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

/// 无头自检输出（--core-plan 用，便于发布后冒烟验证，无需 GUI）。
/// 输出含 latest_via（本次从 rollback / canary / latest / versions 哪条通道选出）：
/// 运维在无 GUI 的机器上核对"rollback tag 存在 = 回退进行中"，靠的就是这个入口。
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

/// 目标版本是经哪条通道选出的（仅供自检/日志，不参与安装决策）。
/// 重新查一遍而不改 latest_version 签名：其调用点多、改动面大，
/// 且本函数只在 --core-plan 自检路径执行，多一次探测的代价可接受。失败绝不编造通道（RC-5）。
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

    /// 版本语义共享测试向量：壳（Rust）与内核（JS）各自实现校验/比较，实测过分叉。
    /// 跨语言无法共享代码，故共享行为规格 `shell-release/version-vectors.json`
    /// （内核仓有逐字节相同的一份），单侧改语义而没同步则本测试失败。
    /// include_str! 编译期嵌入：文件缺失直接编译失败，强于运行时读取的静默跳过。
    const VECTORS: &str = include_str!("../../shell-release/version-vectors.json");

    /// 从形如 `{"input": "x", "valid": true}` 的对象体里取字符串字段。
    fn str_field(body: &str, key: &str) -> Option<String> {
        let pat = format!("\"{}\":", key);
        let after = body.split(&pat).nth(1)?;
        let mut it = after.split('"');
        it.next()?;
        Some(it.next()?.to_string())
    }

    /// 取布尔字段（只认 `"key": true`）。
    fn bool_field(body: &str, key: &str) -> Option<bool> {
        let pat = format!("\"{}\":", key);
        let after = body.split(&pat).nth(1)?;
        let v = after.trim_start();
        if v.starts_with("true") { Some(true) } else { Some(false) }
    }

    /// 从一份 registry 包元数据里取出目标版本的 `dist` 段（测试夹具）。
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
        // 算法不对、长度不对、根本不是 base64 —— 一律「没有校验值」，不拿别的摘要凑数。
        for bad in ["sha1-abc", "!!!", "sha512-YQ=="] {
            let d = dist_meta(&format!(
                r#"{{"versions":{{"0.1.6-BETA.3":{{"dist":{{"integrity":"{bad}"}}}}}}}}"#
            ));
            assert_eq!(parse_integrity(d.get("integrity")), None, "{bad} 不该被当成校验值");
        }
        assert_eq!(parse_integrity(None), None);
    }

    /// 落点名由 registry 给的字符串参与拼成，所以它必须过不了目录穿越这一关。
    #[test]
    fn dist_slug_leaves_no_path_separators_or_dots() {
        let s = dist_slug("@dsh-sup/dsh-core-win-x64");
        assert_eq!(s, "_dsh-sup_dsh-core-win-x64", "scope 里的 / 必须被换掉：{s}");
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

    /// 取整数字段。
    fn int_field(body: &str, key: &str) -> Option<i32> {
        let pat = format!("\"{}\":", key);
        let after = body.split(&pat).nth(1)?;
        let digits: String = after.trim_start()
            .chars()
            .take_while(|c| c.is_ascii_digit() || *c == '-')
            .collect();
        digits.parse().ok()
    }

    /// 把 JSON 文本里每个对象块（`{` … `}`）都取出来：栈记录 `{` 起点，遇 `}` 弹出一个对象。
    /// 再按长度过滤掉包住整份文件的根对象，只留逐条向量的小对象。
    /// 已知足够：向量文件里字符串不含花括号（数据由本仓维护）。
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
        // 根对象 = 唯一「包住整份文件」的那个（长度接近全文）——过滤掉。
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

    // 跨源仲裁（通道契约 + 镜像同步滞后）—— latest_pick 决策路径的测试。
    // 通道决策本身由 release_channel.rs 的单测逐分支覆盖；此处覆盖多源各自决策后的仲裁。

    use crate::release_channel::{CH_CANARY, CH_LATEST, CH_ROLLBACK, CH_VERSIONS};

    fn cand(v: &str, lat: u128, src: &str, via: &'static str) -> Candidate {
        (v.to_string(), lat, src.to_string(), via)
    }

    #[test]
    fn pick_best_prefers_higher_version_within_same_channel() {
        // 同一通道内取更高版本 —— 解决"某镜像元数据滞后一版"。
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
        // RC-2 回归（跨源形态）：A 源已同步 rollback（低版本），B 源还是 latest（高版本）。
        //   若按数字大小仲裁，B 会压过 A，紧急回退无法全量生效。
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
        // 通道优先级即发布通道契约的步序；与版本数字无关。
        assert!(channel_rank(CH_ROLLBACK) < channel_rank(CH_CANARY));
        assert!(channel_rank(CH_CANARY) < channel_rank(CH_LATEST));
        assert!(channel_rank(CH_LATEST) < channel_rank(CH_VERSIONS));
        // 交叉验证：灰度版本低于 latest 时，灰度机仍取灰度
        let got = pick_best(vec![
            cand("0.9.9", 1, "a", CH_LATEST),
            cand("0.1.6-BETA.1", 900, "b", CH_CANARY),
        ])
        .unwrap();
        assert_eq!(got.3, CH_CANARY);
    }

    /// RC-G5 反向：判据必须能识别"取全量最高"的旧形态 —— 否则门禁是空转的。
    /// 旧形态与通道契约在同一份元数据上给出不同答案，改回旧实现必然被本测试抓到。
    #[test]
    fn pick_best_rejects_old_highest_of_all_form() {
        let meta = serde_json::json!({
            "dist-tags": { "latest": "0.1.5-BETA.3" },
            "versions": { "0.1.5-BETA.3": {}, "1.0.0-BETA.1": {} },
        });
        // 契约第 3 步：信 latest（BETA 数字大也不动）
        let picked = crate::release_channel::select(&meta, false).unwrap();
        assert_eq!(picked.version, "0.1.5-BETA.3");
        // 旧的"全量最高"会选 1.0.0-BETA.1 —— 两者不同，故本门禁非空转
        let old_would_pick = "1.0.0-BETA.1";
        assert_ne!(picked.version, old_would_pick, "RC-G5 反向自检失败");
    }

    #[test]
    fn pick_best_empty_is_none() {
        assert!(pick_best(vec![]).is_none(), "无候选必须返回 None（由调用方如实报错，RC-5）");
    }

    // 回退端到端（RC-2）：回退目标低于当前版本，必须由通道信号（via=rollback）参与判定，
    // 否则被判 action=none、回退到不了用户。本组测试锁定该行为，防止退回纯版本比较。

    fn pick(v: &str, via: &'static str) -> Result<LatestPick, String> {
        Ok(LatestPick { version: v.to_string(), origin: "test".into(), via: via.to_string() })
    }

    #[test]
    fn rollback_lower_version_still_triggers_action() {
        // 本机 0.1.5，回退目标 0.1.4（更低）：必须判为需动手，而非"已是最新"
        let p = build_plan(Some("0.1.5".into()), pick("0.1.4", "rollback"));
        assert_eq!(p["action"], "upgrade", "回退目标更低时必须触发（否则 RC-2 端到端断裂）");
        assert_eq!(p["available"], true);
        assert_eq!(p["isRollback"], true);
        assert_eq!(p["latestVia"], "rollback");
        assert_eq!(p["latest"], "0.1.4");
    }

    #[test]
    fn same_version_via_rollback_is_noop() {
        // 回退目标 == 当前版本：无意义，不动手（避免无谓重装）
        let p = build_plan(Some("0.1.5".into()), pick("0.1.5", "rollback"));
        assert_eq!(p["action"], "none");
        assert_eq!(p["isRollback"], true);
    }

    #[test]
    fn non_rollback_lower_version_does_not_trigger() {
        // 反向对照：非回退通道给出更低版本（陈旧 latest）不得触发
        //   （契约缺陷 1 的场景：陈旧与回退必须区分）
        let p = build_plan(Some("0.1.5".into()), pick("0.1.1-BETA.1", "latest"));
        assert_eq!(p["action"], "none", "陈旧 latest 不得被误判为回退");
        assert_eq!(p["isRollback"], false);
    }

    #[test]
    fn rollback_above_current_is_normal_upgrade() {
        // 回退 tag 指向更高版本（运维设错/已恢复正常）：按正常升级处理
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
