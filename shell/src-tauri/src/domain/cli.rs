//! 无头自检入口（任何平台可跑，无需 GUI）：不建图形会话即可验证镜像 / 环境 / 内核治理链路。用户的机器大多没有 Xvfb，出问题时这些命令是唯一的现场取回手段。


pub(crate) fn cli_mirror_plan() -> i32 {
    println!("== 镜像测速自检 ==");
    let m = crate::mirror::load();
    println!("Node 候选 {} 个 / npm 候选 {} 个", m.node.len(), m.npm.len());
    println!();
    println!("--- 并行测速（Node index.json）---");
    let np = crate::mirror::probe_all(&m.node, "index.json");
    for p in &np {
        println!(
            "  {:<48} {} {:>6} ms",
            p.source,
            if p.ok { "可达" } else { "不可达" },
            p.latency_ms
        );
    }
    println!();
    println!("--- 并行测速（npm registry）---");
    let pp = crate::mirror::probe_all(&m.npm, "");
    for p in &pp {
        println!(
            "  {:<48} {} {:>6} ms",
            p.source,
            if p.ok { "可达" } else { "不可达" },
            p.latency_ms
        );
    }
    println!();
    match np.iter().find(|p| p.ok) {
        Some(b) => println!("Node 选中: {} ({} ms)", b.source, b.latency_ms),
        None => println!("Node 选中: 无（全部不可达）"),
    }
    match pp.iter().find(|p| p.ok) {
        Some(b) => println!("npm  选中: {} ({} ms)", b.source, b.latency_ms),
        None => println!("npm  选中: 无（全部不可达）"),
    }
    0
}

pub(crate) fn cli_env_plan() -> i32 {
    println!("== 环境探测自检 ==");
    println!("平台          = {}", std::env::consts::OS);
    // 候选摘要由**探测线程**写入缓存，必须在 status() 之后再读，否则首次调用会读到空串。
    let out = crate::nodeprobe::status(std::time::Duration::from_secs(60));
    println!("{}", crate::nodeprobe::candidate_summary());
    println!("完成          = {}", out.finished);
    println!("耗时          = {} ms", out.elapsed_ms);
    if let Some(e) = &out.error {
        println!("失败原因      = {}", e);
    }
    match (&out.path, &out.version) {
        (Some(p), Some(v)) => println!("node          = {} @ {}", v, p.display()),
        _ => println!("node          = （未找到）"),
    }
    if let Some((on, ms)) = crate::nodeprobe::current_stuck() {
        println!("仍在探测    = {} （已 {} ms）", on, ms);
    }
    let deps = super::probes::dependents(out.path.clone());
    let mut all = out.records.clone();
    all.extend(deps.records);
    println!("探测记录:");
    print!("{}", super::probes::render(&all));
    0
}

pub(crate) fn cli_plan() -> i32 {
    let out = crate::nodeprobe::status(std::time::Duration::from_secs(30));
    let sys = match (&out.path, &out.version) {
        (Some(p), Some(v)) => Some((p.clone(), v.clone())),
        _ => None,
    };
    match &sys {
        Some((p, v)) => println!("node=present {} @ {}", v, p.display()),
        None => println!("node=missing（finished={}）", out.finished),
    }
    println!("node_probe_candidates={}", crate::nodeprobe::candidate_summary());
    print!("{}", super::probes::render(&out.records));
    match crate::node::latest_lts() {
        Ok(c) => {
            println!("latest_lts={} file={}", c.version, c.file);
            println!("mirror_selected={}", c.source);
            for (s, ok, ms) in &c.probes {
                println!("mirror_probe={} ok={} latency_ms={}", s, ok, ms);
            }
            println!("node_outdated={}", crate::node::outdated(sys.as_ref().map(|x| x.1.as_str()), &c.version));
            0
        }
        Err(e) => { eprintln!("latest_lts_error={}", e); 1 }
    }
}

pub(crate) fn cli_service_plan() -> i32 {
    println!("== 守卫服务定义自检 ==");
    println!("平台          = {}", std::env::consts::OS);
    println!("服务定义路径  = {}", crate::platform::service().definition_path().display());
    println!("现存          = {}", if crate::platform::service().is_defined() { "是" } else { "否" });
    println!(
        "HOME          = {}",
        std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")).unwrap_or_else(|_| "(未设置)".into())
    );

    // 守卫可执行文件定位（与实际 ensure_guard 同一路径推导，避免「自检通过但运行时找不到」）。DSH_GUARD_BIN 可显式覆盖：用于 1) 自动定位失败的机器做诊断 2) 测试隔离 HOME。
    let guard: Option<std::path::PathBuf> = std::env::var("DSH_GUARD_BIN")
        .ok()
        .filter(|s| !s.is_empty())
        .map(std::path::PathBuf::from)
        .or_else(crate::core::locate_core_for_cli);
    match &guard {
        Some(p) => {
            println!("守卫可执行    = {}", p.display());
            println!("守卫存在      = {}", if p.is_file() { "是" } else { "否" });
        }
        None => println!("守卫可执行    = （未定位到，请先安装内核）"),
    }

    // 打出的必须是**真正会写进服务定义的那一行**：走运行时同一条装配路径（LaunchSpec::from_runtime + service_command），不在此另拼一遍，否则「自检显示正确、实际写入不同」本身就是排障陷阱。
    match (&guard, crate::runtime_contract::read_node()) {
        (Some(g), Some(rt)) => match crate::platform::LaunchSpec::from_runtime(&rt, g.clone()) {
            Ok(spec) => {
                let (shell, args) = spec.service_command();
                println!("壳自身路径    = {}", shell.display());
                println!("将写入的定义  = {}", crate::platform::service_exec_line(shell, args));
            }
            Err(e) => println!("将写入的定义  = 装不出来：{}", e),
        },
        _ => println!("将写入的定义  = （守卫或 node 契约未就绪，建立时会先解析）"),
    }

    let apply = std::env::args().any(|a| a == "--service-apply");
    if !apply {
        println!();
        println!("（未写盘。加 --service-apply 实际建立服务定义）");
        return 0;
    }
    let Some(g) = guard else {
        eprintln!("无法建立：未定位到守卫可执行文件（先安装内核）");
        return 2;
    };
    let Some(rt) = crate::runtime_contract::ensure() else {
        eprintln!("无法建立：Node 运行环境未就绪（无法解析 node/npm）");
        return 2;
    };
    let spec = match crate::platform::LaunchSpec::from_runtime(&rt, g) {
        Ok(s) => s,
        Err(e) => { eprintln!("无法建立      = 启动规格装配失败：{}", e); return 2; }
    };
    match crate::platform::service().ensure_defined(&spec) {
        Ok(desc) => {
            println!();
            println!("建立结果      = {}", desc);
            println!("建立后现存    = {}", if crate::platform::service().is_defined() { "是" } else { "否" });
            0
        }
        Err(e) => {
            eprintln!("建立失败      = {}", e);
            1
        }
    }
}

pub(crate) fn cli_run_guard() -> i32 {
    // 诊断留痕：此前只报一句"未找到"，无法区分是 runtime 契约缺失还是内核候选全部取不到版本。
    // 真机上两者文件都在却仍失败 ⇒ 必须分别报告，否则排障只能靠推理。
    let rt = crate::runtime_contract::ensure();
    let cands = crate::domain::coreloc::locate_core_candidates(None);
    let picked = crate::domain::coreloc::pick_highest(cands.clone());
    crate::update::log(&format!(
        "[run-guard] 诊断: runtime={} 候选数={} 选中={}",
        if rt.is_some() { "ok" } else { "缺失/失效" },
        cands.len(),
        picked.as_ref().map(|p| p.display().to_string()).unwrap_or_else(|| "无".to_string())
    ));
    for c in &cands {
        crate::update::log(&format!(
            "[run-guard] 候选 {} 版本={}",
            c.display(),
            crate::core::installed_version(c).unwrap_or_else(|| "取不到".to_string())
        ));
    }
    let Some((rt2, guard)) = crate::domain::guardctl::resolve_local(None) else {
        eprintln!("[run-guard] 本地检测失败：未找到可用的 node 或内核守卫");
        return 1;
    };
    let _ = rt;
    let _ = rt2;
    eprintln!("[run-guard] node={} guard={}", rt.node.display(), guard.display());
    let spec = match crate::platform::LaunchSpec::from_runtime(&rt, guard) {
        Ok(s) => s,
        Err(e) => { eprintln!("[run-guard] 启动规格组装失败：{}", e); return 1; }
    };
    match crate::platform::exec_guard(&spec) {
        Ok(()) => 0,
        Err(e) => {
            eprintln!("[run-guard] {}", e);
            1
        }
    }
}

  /// 无头看护入口（`--watchdog`，Windows 计划任务每 5 分钟调用一次）。判据只有 `guardctl::ready()`（TCP + `/healthz` 2xx），与 GUI 启动、面板轮询同一实现；此处不得内嵌 PowerShell 用 `Test-NetConnection` 只看 TCP 端口（端口被占但服务没起 = 判为活）。
/// 只拉守卫不拉 GUI；不走 ensure_guard（那条链含线上对齐，看护无权改变安装态），复用 `ensure_started`。
pub(crate) fn cli_watchdog() -> i32 {
    let port = crate::env::current_api_port();
    if crate::domain::guardctl::ready(port, WATCHDOG_PROBE_TIMEOUT) == crate::domain::guardctl::Readiness::Ready {
        return 0;
    }
    let say = |s: &str| crate::update::log(&format!("[watchdog] {}", s));
    say(&format!("守卫未就绪（端口 {}）· 请求拉起", port));
    let Some((rt, guard)) = crate::domain::guardctl::resolve_local(None) else {
        say("本地检测失败：未找到可用的 node 或内核守卫");
        return 1;
    };
    let spec = match crate::platform::LaunchSpec::from_runtime(&rt, guard) {
        Ok(s) => s,
        Err(e) => { say(&format!("启动规格组装失败：{}", e)); return 1; }
    };
    match crate::domain::guardctl::ensure_started(&spec, &say) {
        Ok(()) => 0,
        Err(e) => { say(&format!("{}：{}", e.code, e.message)); 1 }
    }
}

const WATCHDOG_PROBE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(2);
