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
    println!("== 监控器登记自检 ==");
    println!("平台          = {}", std::env::consts::OS);
    println!("登记表路径    = {}", crate::platform::service().definition_path().display());
    println!("现存          = {}", if crate::platform::service().is_defined() { "是" } else { "否" });
    println!(
        "HOME          = {}",
        std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")).unwrap_or_else(|_| "(未设置)".into())
    );

    
    let guard: Option<std::path::PathBuf> = std::env::var("DSH_GUARD_BIN")
        .ok()
        .filter(|s| !s.is_empty())
        .map(std::path::PathBuf::from)
        .or_else(crate::core::locate_core_for_cli);
    match &guard {
        Some(p) => {
            println!("内核可执行    = {}", p.display());
            println!("内核存在      = {}", if p.is_file() { "是" } else { "否" });
        }
        None => println!("内核可执行    = （未定位到，请先安装内核）"),
    }

    
    match (&guard, crate::runtime_contract::read_node()) {
        (Some(g), Some(rt)) => match crate::platform::LaunchSpec::from_runtime(&rt, g.clone()) {
            Ok(spec) => {
                let (shell, args) = spec.service_command();
                println!("壳自身路径    = {}", shell.display());
                println!("将写入的定义  = {}", crate::platform::service_exec_line(shell, args));
            }
            Err(e) => println!("将写入的定义  = 装不出来：{}", e),
        },
        _ => println!("将写入的定义  = （内核或 node 契约未就绪，建立时会先解析）"),
    }

    let apply = std::env::args().any(|a| a == "--service-apply");
    if !apply {
        println!();
        println!("（未写盘。加 --service-apply 实际建立服务定义）");
        return 0;
    }
    let Some(g) = guard else {
        eprintln!("无法建立：未定位到内核可执行文件（先安装内核）");
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
    // 一次性凭据校验（J-2 第 3 项）：只有被壳的 spawn_daemon 拉起时才带这个环境变量。
    // 手跑 `lobox-shell --run-guard` 拿不到它 ⇒ 拒绝启动 ⇒ 双守卫少一条成因。
    //
    // 这不是「防恶意」——本机任意进程照样能读到自己环境里的值——而是「防无意」：
    // 用户/脚本手跑一条命令就多起一个内核，是最常见的多实例来源。真正的授权边界
    // 仍靠 mgmt 端点的 peer token（那对着内核），此处只挡「没经壳的手跑」。
    //
    // 验完即从本进程环境移除：后续 exec_guard 拉起的守卫不该继承这个凭据
    // （它是 spawn 方与 cli_run_guard 之间的，不是给内核的）。
    if std::env::var(crate::platform::spawn_token_env()).is_err() {
        crate::telemetry::event::warn(
            "cli.guard_token_missing",
            "cli",
            serde_json::json!({ "pid": std::process::id() }),
        );
        crate::update::log("[run-guard] 缺少一次性凭据：本入口只接受由桌面壳拉起的启动（fail-closed）");
        eprintln!("[run-guard] 缺少一次性凭据：请通过桌面壳启动，不要直接运行本命令");
        return 2;
    }
    std::env::remove_var(crate::platform::spawn_token_env());
    // 本路径**没有**可用的「是否已有活守卫」判据。曾在此加过一道单守卫门
    // （读 supervisor/guard.lock 的 pid + pid_alive），已撤。撤的原因：
    //   · guard.lock 在全仓没有任何写入方 —— bin/lobox:237 的 R7 注释明言
    //     「已删除：守卫锁」，state-root.js:61 只读它（detectLegacyInstall）。
    //     本机实测锁内容是一个 13:40 就死掉的 pid，此后再无人维护。
    //   · 壳自己的进程表（process_manager::handle().states）是进程内内存
    //     HashMap，无持久化；而 --run-guard 是独立进程（main.rs:141 早于
    //     Tauri setup），它的 states 恒为空。
    //   · /healthz 探活被 R7 明确否弃（guardctl.rs:158-162：启动判据已从
    //     healthz 改为进程表）。
    // ⇒ 这道门读到死 pid 就放行，等于每来一个 --run-guard 都放行，
    //   双守卫照常发生。空转的门比没有门更危险（让人以为已防住），故撤。
    //
    // 「防双持归壳」在第三条路上从未兑现，且当前无判据可用。这个缺口已记账，
    // 待有真正的单守卫状态载体（写方在读方之前先存在）再实现。
    {
        let rt_diag = crate::runtime_contract::ensure();
        let cands = crate::domain::coreloc::locate_core_candidates(None);
        let picked = crate::domain::coreloc::pick_best(cands.clone()).map(|(p, _)| p);
        crate::telemetry::event::info("cli.guard_diagnosis", "cli", serde_json::json!({
            "runtime": if rt_diag.is_some() { "ok" } else { "缺失/失效" },
            "candidates": cands.len(),
            "picked": picked.as_ref().map(|p| p.display().to_string()).unwrap_or_else(|| "无".to_string())
        }));
        for c in &cands {
            crate::telemetry::event::info("cli.guard_candidate", "cli", serde_json::json!({
                "path": c.display().to_string(),
                "version": crate::core::installed_version(c).unwrap_or_else(|| "取不到".to_string())
            }));
        }
    }
    let Some((rt, guard)) = crate::domain::guardctl::resolve_local(None) else {
        eprintln!("[run-guard] 本地检测失败：未找到可用的 node 或内核");
        return 1;
    };
    eprintln!("[run-guard] node={} guard={}", rt.node.display(), guard.display());
    let spec = match crate::platform::LaunchSpec::from_runtime(&rt, guard) {
        Ok(s) => s,
        Err(e) => { eprintln!("[run-guard] 启动规格组装失败：{}", e); return 1; }
    };
    // 复用全局 handle()：此前这里另建一个 ProcessManager，与 main 注册的那张表
    // 并存。危害不在两张表，而在契约文件——mgmt::run 每次都会 export_port，
    // 于是这个 guard 进程的端口覆盖壳写下的那份；而 pm-client.js 只校验 pidAlive，
    // 内核的全部 register/setDesired/onPhase 上报就打进 guard 进程那张无人查询、
    // 无人 heal 的临时表（这正是 core 永不自愈的上游原因）。
    // 仅复用 handle() 不足以闭环（两个进程各有各的单例），所以真正的约束落在
    // mgmt::run：契约文件已有在世所有者时不得接管。详见 export_port 的 owner 检查。
    let _supervisor_core = {
        let pm = crate::process_manager::handle();
        match tokio::runtime::Builder::new_multi_thread().enable_all().build() {
            Ok(runtime) => {
                runtime.spawn(crate::process_manager::mgmt::run(pm.clone()));
                std::thread::sleep(std::time::Duration::from_millis(300));
                Some(runtime)
            }
            Err(e) => {
                eprintln!("[run-guard] 监督端点运行时创建失败：{}", e);
                None
            }
        }
    };
    match crate::platform::exec_guard(&spec) {
        Ok(()) => 0,
        Err(e) => {
            eprintln!("[run-guard] {}", e);
            1
        }
    }
}

