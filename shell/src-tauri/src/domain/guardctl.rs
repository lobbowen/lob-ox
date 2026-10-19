//! 内核的启停与就绪判定（生命周期所有权的调用方）。铁律：壳**自己**是内核生命周期的所有者 ——
//! 服务管理器是产品自身的监控器（见 `platform::service`），进程由本产品持有，**不向**
//! systemd / launchd / 任务计划程序投递任何东西，也不存在「用系统通道投递」的选项。
//! 阶段序列 P0 契约 -> P1 对齐 -> P3 定位 -> P4 登记 -> P5 启动 -> P6 就绪；P1 是 P5 的前置（磁盘内核必须等于线上最新，否则拒绝启动）。所有等待都有上限，退出也要能在受管对象无响应时走完。

// `std::net::{TcpStream, ToSocketAddrs}` 与 `std::sync::atomic::{AtomicU32, Ordering}`
// 已删：它们属于旧的「端口探测」实现，而件 1 把它换成了「进程表判据」
// （`ensure_core` 的 mine/claimed，见本文件 ensure_core）。留着就是 unused warning，
// 而本项目对 warning 的纪律是零（CI 的 cargo check --tests 是 gate）。
use tauri::{Emitter, Manager};


#[derive(Debug, Clone)]
pub struct LaunchError {
    pub code: &'static str,
    pub message: String,
}

impl LaunchError {
    pub(crate) fn new(code: &'static str, message: impl Into<String>) -> Self {
        LaunchError { code, message: message.into() }
    }
}




/// `--run-guard` 的本地检测（不触网）：解析可运行的 node + 内核（取本地最高版本）。服务定义只指向稳定入口，故每次启动重新检测，node 迁移（nvm/volta/fnm）与内核升级后自动适配；线上对齐（P1）仍由壳在创建/启动服务前把关，此处只做本地解析，离线也能启动。
pub fn resolve_local(resource_dir: Option<std::path::PathBuf>) -> Option<(crate::runtime_contract::NodeRuntime, std::path::PathBuf)> {
    // --run-guard 是真正 spawn 内核的入口，走同一条启动门补齐逻辑（达标 + 升到最新 LTS）。
    let rt = crate::runtime_contract::ensure_with_upgrade()?;
    let guard = crate::domain::coreloc::pick_best(
        crate::domain::coreloc::locate_core_candidates(resource_dir),
    )
    .map(|(p, _)| p)?;
    Some((rt, guard))
}

// R7-架构：停机不再走「/session/stop 握手 + 轮询 sessionState + service().stop()」三段式。
// 那套是守卫所有权语义：守卫是「唯一监管者」，要等它自己拆完服务链再让外部停。
// （「守卫」是内核被接管前的历史命名，本段保留它是为了说明这套语义为何被废。）
// 进程管理时代壳直接持有进程句柄（adopt_spawned），停机就是停进程表里的每个对象，
// 没有握手、没有让出端口的等待预算、没有 GUARD_STOP_FAILED 这条路径。
pub(crate) fn shutdown_all() {
    shutdown_all_with_reason("shell_shutdown_all")
}

/// 停机 + 留痕带 `reason`。
///
/// 为什么要 `reason`：真机验收时要能**机械分流**「哪条路径触发的」——
///   · `shell_shutdown_all`            ⇒ 主动退出（托盘 quit / 窗口 exit）
///   · `session_ending`                ⇒ 关机/注销（`WM_QUERYENDSESSION`，件 1 重做）
///   · `shell_shutdown_all_contract_fallback` ⇒ 契约文件兜底那条支
/// 缺了它，验收时只知道「跑没跑」，不知道「该跑的那条为什么没跑」
/// （上次件 1 FAIL 正是卡在这里：`kill_attempt` 0 命中，但无从判断是
///   「钩子没触发」还是「触发了但杀不动」）。
pub(crate) fn shutdown_all_with_reason(reason: &str) {
    let pm = crate::process_manager::handle();
    let ids: Vec<String> = {
        let s = pm.states.lock().unwrap_or_else(|e| e.into_inner());
        s.keys().cloned().collect()
    };
    for id in ids {
        // 先置期望停机（自愈节拍据此不再重拉），再按 pid 直接终止。
        pm.set_desired(&id, crate::process_manager::state_machine::Desired::Stopped);
        let pid = {
            let s = pm.states.lock().unwrap_or_else(|e| e.into_inner());
            s.get(&id).and_then(|st| st.pid)
        };
        // 只按本表持有的 pid 精确停止：pid 为 None（core 行恰好如此）时什么都不做。
        // 此前在此退化为 service().stop() 整表杀——那会连带停掉非本产品的 node，
        // 且 core 行每次退出必然走一次（register_core 造的正是 Running + pid=None）。
        //
        // 留痕（field-acceptance 查出的缺口）：此前这里只记「停了/没停」，
        // 而本机 5 个内核怎么死的四种可能全部无法证实，因为产品不记录进程退出。
        // ⇒ kill 前后各一条，带 pid + 原因 + 结果；None 支要记**为什么**没 pid
        //   （「壳没拉起它」与「认领时契约里没在世 pid」是两个不同原因，
        //    前者该修、后者只是此刻无从下手）。
        match pid {
            Some(p) => {
                // ⚠️ `serde_json::json!` 的 value 位只接受 expr，不接受块表达式
                //    （`{ let s = ...; ... }`）——宏的匹配规则是 `$v:expr`，块匹配不上，
                //    报 `unexpected end of macro invocation`。⇒ 先算出来再传。
                let adopted = {
                    let s = pm.states.lock().unwrap_or_else(|e| e.into_inner());
                    s.get(&id).map(|st| st.adopted).unwrap_or(false)
                };
                crate::telemetry::event::info("process.kill_attempt", "guardctl", serde_json::json!({
                    "id": id, "pid": p, "reason": reason,
                    "adopted": adopted
                }));
                let outcome = crate::bounded::kill_tree_pid(p);
                let ok = outcome.is_success();
                crate::telemetry::event::info("process.kill_result", "guardctl", serde_json::json!({
                    "id": id, "pid": p, "ok": ok,
                    "outcome": format!("{:?}", outcome),
                    "signal": outcome_label(&outcome),
                }));
                if !ok {
                    crate::telemetry::event::warn("process.stop_incomplete", "guardctl", serde_json::json!({ "id": id, "pid": p, "outcome": format!("{:?}", outcome) }));
                }
            }
            None => {
                // 进程表无 pid 时不再无条件跳过：从契约文件再拿一次（与件 1 同源）。
                // 此前这里只发一条 stop_skipped 就走 ⇒ 壳退出时那个内核还活着。
                // 「壳退内核必死」要求这条兜底真的去杀，而不是记一条「我跳过了」。
                let contract_pid = crate::process_manager::mgmt::live_contract_owner();
                match contract_pid {
                    Some(p) => {
                        crate::telemetry::event::info("process.kill_attempt", "guardctl", serde_json::json!({
                            "id": id, "pid": p, "reason": "shell_shutdown_all_contract_fallback",
                            "source": "guard-mgmt.json"
                        }));                        let outcome = crate::bounded::kill_tree_pid(p);
                        let ok = outcome.is_success();
                        crate::telemetry::event::info("process.kill_result", "guardctl", serde_json::json!({
                            "id": id, "pid": p, "ok": ok,
                            "outcome": format!("{:?}", outcome),
                            "signal": outcome_label(&outcome),
                        }));
                        if !ok {
                            crate::telemetry::event::warn("process.stop_incomplete", "guardctl", serde_json::json!({ "id": id, "pid": p, "outcome": format!("{:?}", outcome) }));
                        }
                    }
                    None => {
                        // ⚠️ `serde_json::json!` 的 value 位只接受 expr，不接受块表达式
                        //    （宏匹配规则是 `$v:expr`）⇒ 先算出来再传。
                        // 两个字段同源于进程表同一把锁 ⇒ 取一次锁算两个值，
                        // 而不是在宏里各 lock 一次（那既是块表达式，也重复加锁）。
                        let (adopted, had_spawn_cmd) = {
                            let s = pm.states.lock().unwrap_or_else(|e| e.into_inner());
                            match s.get(&id) {
                                Some(st) => (st.adopted, !st.spawn_cmd.is_empty()),
                                None => (false, false),
                            }
                        };
                        crate::telemetry::event::info("process.stop_skipped", "guardctl", serde_json::json!({
                            "id": id,
                            "reason": "进程表无 pid 且契约无在世 pid",
                            // 区分两种 None：壳从未拉起过它（adopted=true 且契约也没 pid）
                            // vs 壳拉起过但登记丢失（后者是缺陷）。
                            "adopted": adopted,
                            "had_spawn_cmd": had_spawn_cmd
                        }));
                    }
                }
            }
        }
    }
    crate::telemetry::event::info("process.all_stopped", "guardctl", serde_json::json!({
        "at": crate::update::now_iso_human()
    }));
}

/// kill 结果的简短标签，供留痕直接读（不必去解 Debug 枚举）。
fn outcome_label(o: &crate::bounded::KillOutcome) -> &'static str {
    match o {
        crate::bounded::KillOutcome::Terminated => "terminated",
        crate::bounded::KillOutcome::AlreadyGone => "already_gone",
        crate::bounded::KillOutcome::Failed => "failed",
    }
}

/// 服务管理器路径（P4 建立定义 -> P5 请求启动）的阶段产物。不变量由结构强制：`started` 只可能在 `defined` 为 `Ok` 时才是 `Some` —— 定义失败时那条出边是关闭的。丢掉 `ensure_defined` 的错误再无条件 `start()`，报错就只剩「/Run 失败（退出码 1）」，真实失败点可能在更早的 P4。
/// 内核进程登记表项：把「内核」作为最高优先级负载收进机箱进程表。
/// 这是进程所有权归壳的体现 —— 表里没有内核，自愈就无从谈起。
/// spawn_cmd 必须指向**真实**内核可执行入口（与 spawn 路径解析出的 spec.guard 一致）。
/// 空 Vec 会被 spawn_healer 跳过，core 就永远不可 heal——这不是保守，是静默失去自愈。
/// 解析不出时返回空 Vec（不退回 `<self_exe> --run-guard`）：见 core_spawn_cmd 的说明。
fn core_desc() -> crate::process_manager::state_machine::WorkloadDesc {
    crate::process_manager::state_machine::WorkloadDesc {
        id: "core".to_string(),
        spawn_cmd: core_spawn_cmd(),
        priority: crate::process_manager::state_machine::Priority::Core,
        env: Vec::new(),
    }
}

/// 内核 spawn 命令的**唯一**产出点：`<node> <guard> daemon`。
///
/// 曾经有两个分支：正常分支首元素 `rt.node`，fallback 退化成
/// `<self_exe> --run-guard`（首元素是壳自己）。两者不同形 ⇒ healer 同时存在两种
/// spawn 形态，runtime 解析不稳时在两者间来回切，每切一次就多拉起一个 daemon
/// —— 本机 3 daemon 的第二种成因。
///
/// 现在收成一个函数、一种形状。解析不出时返回空 Vec：`spawn_healer` 见到
/// `spawn_cmd.is_empty()` 会 continue，core 暂不可 heal 但不会多拉一个进程。
/// 静默失去自愈与多拉一个 daemon 之间，后者更糟（它直接造成双守卫并存）。
fn core_spawn_cmd() -> Vec<String> {
    let Some(rt) = crate::runtime_contract::ensure() else {
        return Vec::new();
    };
    let guard = crate::domain::coreloc::pick_best(crate::domain::coreloc::locate_core_candidates(None))
        .map(|(p, _)| p)
        .or_else(|| crate::core_contract::read().map(|c| c.bin));
    let Some(g) = guard else {
        return Vec::new();
    };
    let g = crate::domain::coreloc::normalize_guard(g, crate::core::package_name().ok().as_deref());
    vec![
        rt.node.to_string_lossy().into_owned(),
        g.to_string_lossy().into_owned(),
        "daemon".to_string(),
    ]
}

/// 内核已在服役（壳未持有其句柄，例如 exec 替换或已存在实例）：登记为 running，pid 未知。
///
/// 这是「认领」：pid 为空 ⇒ `already` 判据（只认 `pid.is_some()`）不会把它当成
/// 「壳拉起的在役内核」，下次启动仍会走完整启动序列 —— 那是对的，因为壳没有它的
/// 句柄，停不起也管不了。但条目本身要能在排障时认出是认领来的（`adopted = true`）。
fn register_core(app: &tauri::AppHandle) {
    if let Some(pm) = app.try_state::<std::sync::Arc<crate::process_manager::ProcessManager>>() {
        pm.register_workload(core_desc());
        pm.on_phase("core", crate::process_manager::state_machine::Phase::Running);
        pm.set_desired("core", crate::process_manager::state_machine::Desired::Running);
        // 认领来的内核也要有 pid，否则壳退出时杀不掉它（S-1 #1）。
        // 判据与 live_contract_owner 同源：读 guard-mgmt.json 的 pid + pid_alive 实探。
        // 死了就不登记 —— 宁可 None 也不登记一个死 pid：那会让 shutdown_all 去 kill
        // 一个不存在的进程，还把「认领失败」伪装成「已接管」。
        if let Some(pid) = crate::process_manager::mgmt::live_contract_owner() {
            pm.adopt_spawned(core_desc(), pid);
            pm.on_phase("core", crate::process_manager::state_machine::Phase::Running);
            crate::telemetry::event::info(
                "process.adopted_with_pid",
                "guardctl",
                serde_json::json!({ "id": "core", "pid": pid }),
            );
        } else {
            crate::telemetry::event::info(
                "process.adopted_without_pid",
                "guardctl",
                serde_json::json!({ "id": "core", "reason": "契约无在世 pid" }),
            );
        }
    }
}

/// 壳自持路径：壳 spawn 出内核进程，把 pid 一并登记（进程所有权归壳）。
/// `adopted = false`（壳持有句柄），故 `already` 判据认它 —— 同一壳再次启动时
/// 不会重复拉起，这正是「防双持」在壳在场两条路上生效的方式。
fn register_core_spawned(app: &tauri::AppHandle, pid: u32) {
    if let Some(pm) = app.try_state::<std::sync::Arc<crate::process_manager::ProcessManager>>() {
        pm.adopt_spawned(core_desc(), pid);
        pm.set_desired("core", crate::process_manager::state_machine::Desired::Running);
    }
}

/// 启动路径的内核定位（不触网）：版本校对已前移到引导页的 stepCorePlan，
/// 启动只负责把「本地已装内核」定位出来并拉起 —— 联网比对版本属业务判定，壳不在此越界。
fn resolve_local_kernel(
    app: &tauri::AppHandle,
) -> Result<(std::path::PathBuf, String), String> {
    let resource_dir = app.path().resource_dir().ok();
    if let Some(c) = crate::core_contract::read() {
        let bin = crate::domain::coreloc::normalize_guard(c.bin, None);
        if bin.is_file() {
            return Ok((bin, c.version));
        }
    }
    let (guard, version) = crate::domain::coreloc::pick_best(
        crate::domain::coreloc::locate_core_candidates(resource_dir),
    )
    .ok_or_else(|| "本地未找到任何已安装内核".to_string())?;
    let version = version.unwrap_or_else(|| "unknown".to_string());
    let prefix = crate::core::global_prefix_for(&guard);
    crate::core_contract::write(&crate::core_contract::InstalledCore {
        bin: guard.clone(),
        prefix,
        version: version.clone(),
        source: "local-adopted".into(),
    });
    Ok((guard, version))
}

// R7-架构：启动判据从「端口上有没有人 + 守卫会话语义」改为「进程表里有没有我持有的内核」。
// 原逻辑三段：port_open → serving_state（/healthz + /session/status）→ 停等让出端口。
// 那整套是守卫所有权语义（守卫是唯一监管者，壳要等它让端口），也正是打死进程管理路径的地方：
// 端口被外部占用时壳会先花 15 秒等它让，再报 GUARD_STOP_FAILED，而进程管理本可直接认领或重启。
// （「守卫」是内核被接管前的历史命名，本段保留它是为了说明这套语义为何被废。）
// 现在唯一判据是进程表：表里有 running 的内核 → 已在服役；否则走正常启动序列。
pub(crate) fn ensure_core(app: &tauri::AppHandle) -> Result<(), LaunchError> {
    let step = |s: &str| {
        let _ = app.emit("core_progress", serde_json::json!({ "status": s }));
        crate::telemetry::event::info("guard.step", "guardctl", serde_json::json!({ "status": s }));
    };

    // 进程表判据：壳自己 spawn 并持有句柄的内核（pid 已知）才算在服役。
    // 不探端口——端口被别的进程占是端口层的事，归 PortAuthority + heal 处理，
    // 不该在启动路径上阻塞 15 秒再失败。
    //
    // `pid.is_some()` 这一条同时是「来源分流」：认领条目（register_core）pid 为空，
    // 不会进这个分支 ⇒ 下次启动仍走完整序列去把它接管成壳持有的。若这里放开关到
    // 「phase == Running 就算」，认领条目会让壳以为自己在管它，实际停不起也管不了。
    let pm = crate::process_manager::handle();
    let (already, adopted_only) = {
        let s = pm.states.lock().unwrap_or_else(|e| e.into_inner());
        let mine = s.values().any(|st| st.pid.is_some()
            && st.phase == crate::process_manager::state_machine::Phase::Running);
        let claimed = !mine
            && s.values().any(|st| st.adopted
                && st.phase == crate::process_manager::state_machine::Phase::Running);
        (mine, claimed)
    };
    if already {
        step("内核已在服役（进程表登记）· 跳过启动");
        register_core(app);
        return Ok(());
    }
    if adopted_only {
        step("检测到已在运行的内核（非本壳拉起）· 尝试接管");
    }

    // 启动门走 ensure_with_upgrade：开机既要保证「达标」，也要把已达标但落后于
    // 最新 LTS 的环境升上去（min_node 只是下限，目标始终是最新 LTS）。
    // 其余调用点（core_desc / resolve_local / CLI 诊断）仍用 ensure()：它们是查询，
    // 不该在读取路径上触发升级。
    let rt = crate::runtime_contract::ensure_with_upgrade().ok_or_else(|| {
        // 带上环境管理器给出的具体原因（版本过低 / 探测不到 / 自动安装失败），
        // 而不是只说「未就绪」—— 后者让用户完全无从下手。
        LaunchError::new(
            "RUNTIME_MISSING",
            format!(
                "Node 运行环境不可用：{}",
                crate::runtime_contract::last_problem()
                    .unwrap_or_else(|| "无法解析 node/npm".to_string())
            ),
        )
    })?;

    step("正在校验内核与线上版本对齐…");
    let (guard, version) = match resolve_local_kernel(app) {
        Ok(v) => v,
        Err(e) => {
            return Err(LaunchError::new(
                "KERNEL_MISSING",
                format!("未找到已安装的内核（请先在引导页完成内核安装/更新）：{}", e),
            ));
        }
    };
    step(&format!("内核已定位 v{}", version));
    let spec = crate::platform::LaunchSpec::from_runtime(&rt, guard)
        .map_err(|e| LaunchError::new("LAUNCH_SPEC_FAILED", e))?;
    ensure_started(app, &spec, &step)
}

pub(crate) fn ensure_started(
    app: &tauri::AppHandle,
    spec: &crate::platform::LaunchSpec,
    step: &dyn Fn(&str),
) -> Result<(), LaunchError> {
        // 开机自启登记（唯一用途）：让 OS 在登录时把壳拉起来，拉起内核本身不借 OS 通道。
    if let Err(e) = crate::platform::service().ensure_defined(spec) {
        crate::telemetry::event::warn("guard.autostart_failed", "guardctl", serde_json::json!({ "error": e.to_string() }));
    } else {
        crate::telemetry::event::info("guard.autostart_ready", "guardctl", serde_json::json!({}));
    }

        // 正式路径：壳自己拉起内核并持有进程（进程所有权归壳，自愈由机箱进程表按优先级驱动）。
    step("正在拉起内核…");
    // FA-20 hop3 修：**先建行，再 spawn**。
    //
    // 为什么：内核 `sup.start()` 就绪后会经 `/pm/keep-alive` 自报真 pid
    // （core-engineer 的 `bin/lobox:360`），而壳的 `update_pid("core", pid)`
    // 要求进程表里**已有** `core` 行。原顺序是 spawn → await_daemon(等就绪)
    // → register_core_spawned(建行) ⇒ 而内核的自报发生在「就绪那一刻」⇒
    // **自报早于建行** ⇒ `update_pid` 的 `get_mut("core")` 未命中 ⇒
    // 记 `core_pid_update_missed`（1.0.43 实测）⇒ 进程表永远留着入口 pid。
    //
    // ⇒ 先把行建出来（pid 先记 spawn 拿到的入口 pid，那是当时唯一的真值），
    //   等内核自报真 pid 时 `update_pid` 就能命中并改写。
    //   ⇒ 而 `adopt_spawned` 的 phase=Starting 在这里是**正确**的（内核正在起）。
    match crate::platform::service().spawn_daemon(spec) {
        Ok(mut child) => {
            let pid = child.id();
            crate::telemetry::event::info("guard.core_spawned", "guardctl", serde_json::json!({ "pid": pid }));
            // 立即建行（用入口 pid 占位）⇒ 让内核稍后的自报能命中。
            register_core_spawned(app, pid);
            let (verdict, exited) = await_daemon(DAEMON_READY_BUDGET, &mut child);
            if verdict == Readiness::Ready {
                // 行已建（上面）⇒ 此处只把相位推进（内核已就绪）。
                crate::process_manager::handle()
                    .on_phase("core", crate::process_manager::state_machine::Phase::Running);
                return Ok(());
            }
            // FA-20 hop3 修的连带处置：上面为了「让内核自报能命中」提前建了行
            // （pid=入口、phase=Starting）⇒ 而这里启动失败 ⇒ 若留着那行，
            // healer 会看到一个 pid=Some 的行并按它重拉（而那个 pid 是已死的入口）
            // ⇒ 故失败时把行降级成「无 pid + 失败态」，与启动前的认知一致。
            //
            // ⚠️ 不用 `tap_err`（Result 的方法，本机无编译验证 ⇒ 不写没写过的 API），
            //    也不用 `update_pid("core", 0)`（那会设成 Some(0) 而非 None）⇒
            //    直接显式 match，最笨但无歧义。
            {
                let pm = crate::process_manager::handle();
                pm.on_phase("core", crate::process_manager::state_machine::Phase::Failed);
                pm.clear_pid("core");
            }
            Err(LaunchError::new(
                if matches!(exited, ExitState::ExitedWith(_)) {
                    "KERNEL_EXITED"
                } else if matches!(exited, ExitState::ExitedCleanly) {
                    "DAEMON_EXITED_UNREADY"
                } else {
                    "READY_TIMEOUT"
                },
                format!(
                    "内核启动失败（{}）；进程 pid={}{}，其输出见 {}\n内核输出末段：{}",
                    verdict.describe(),
                    pid,
                    exited.describe(),
                    crate::update::guard_log_path().display(),
                    guard_log_tail()
                ),
            ))
        }
        Err(e) => Err(LaunchError::new(
            "KERNEL_SPAWN_FAILED",
            format!("内核拉起失败：{}", e),
        )),
    }
}

/// 兜底直拉后的子进程结局。压成 (Readiness, Option<i32>) 会让两种截然不同的
/// 现场共用同一条话术：干净退出的内核本该立刻报「已退出且未就绪」，
/// 却要烧满 60 秒预算后被说成「仍在运行」。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ExitState {
    /// 子进程干净退出（code 0）。仍需就绪预算——正常路径下入口是先 detach 再退。
    ExitedCleanly,
    /// 子进程非零退出。
    ExitedWith(i32),
    /// 预算用尽，进程仍在。
    StillRunning,
}

impl ExitState {
    pub fn describe(self) -> String {
        match self {
            ExitState::ExitedCleanly => "启动入口已正常退出（退出码 0），但端口始终未就绪".to_string(),
            ExitState::ExitedWith(c) => format!("已退出（{}）", crate::bounded::exit_code_label(Some(c))),
            ExitState::StillRunning => "仍在运行".to_string(),
        }
    }
}

/// 兜底直拉后的等待：就绪判据与 [`ready`] 同源。
/// 非零退出即停：一个已经退出的进程不会再变绿，让它跑满 60 秒预算就是把「拉起即失败」
/// 说成「启动超时」。
/// 退出码 0 **不停**（Windows 稳定入口先 detach 再退），但必须把结局记下来，
/// 否则预算用尽只能说「仍在运行」——这正是「消息谎称仍在运行」那条缺陷。
fn await_daemon(
    budget: std::time::Duration,
    child: &mut std::process::Child,
) -> (Readiness, ExitState) {
    let started = std::time::Instant::now();
    // 就绪态在循环内首次探测即被赋值，初值从不被读到 —— 不给初值会让编译器
    // 要求 definite initialization，而给初值又触发「赋值前从未读取」警告。
    // 用无初值声明 + 循环内首赋值即可消除两难。
    let mut last;
    // 记住子进程是否已退出：退出码 0 在 Windows 上是**正常**的 detach 结局
    // （入口先拉出 node 再退出），不能就此早停——内核可能仍在起。
    // 但必须记住，否则预算用尽时只能说「仍在运行」，把「它早就退了」谎报成还在跑。
    let mut exited: Option<ExitState> = None;
    loop {
        last = ready(crate::env::current_api_port(), READINESS_HTTP_TIMEOUT);
        if last == Readiness::Ready {
            return (last, ExitState::StillRunning);
        }
        if let Ok(Some(st)) = child.try_wait() {
            exited = Some(match st.code() {
                Some(0) => ExitState::ExitedCleanly,
                Some(c) => ExitState::ExitedWith(c),
                None => ExitState::StillRunning,
            });
            // 非零退出是确定失败，没有再等的理由。
            if matches!(exited, Some(ExitState::ExitedWith(_))) {
                return (last, ExitState::ExitedWith(st.code().unwrap_or(0)));
            }
        }
        if started.elapsed() >= budget {
            return (last, exited.unwrap_or(ExitState::StillRunning));
        }
        std::thread::sleep(std::time::Duration::from_millis(500));
    }
}

fn guard_log_tail() -> String {
    let path = crate::update::guard_log_path();
    let text = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(_) => return "(读不到)".to_string(),
    };
    let lines: Vec<&str> = text.lines().filter(|l| !l.trim().is_empty()).collect();
    let tail = lines[lines.len().saturating_sub(6)..].join("\n");
    let chars: Vec<char> = tail.chars().collect();
    let s: String = if chars.len() > 2000 {
        chars[chars.len() - 2000..].iter().collect()
    } else {
        tail.clone()
    };
    if s.trim().is_empty() { "(日志为空)".to_string() } else { s }
}

const DAEMON_READY_BUDGET: std::time::Duration = std::time::Duration::from_secs(60);

/// 内核就绪判据的**唯一**实现产物：`GET /healthz` 返回 2xx —— 唯一算「就绪」的形态。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Readiness {
    Ready,
    PortClosed,
    Http(u16),
    NoHttpResponse,
}

impl Readiness {
    pub(crate) fn describe(self) -> String {
        match self {
            Readiness::Ready => "就绪".to_string(),
            Readiness::PortClosed => "端口不可达".to_string(),
            Readiness::Http(code) => format!("/healthz 返回 {}", code),
            Readiness::NoHttpResponse => "/healthz 无响应".to_string(),
        }
    }
}

/// 裸 TCP 可达判定 —— **只**用于「不再可达 = 进程已停」这类否定问题（重启前的等待）。就绪与否**不得**用它回答（那是 [`ready`] 的活）：端口能连只说明有人在听，内核在绑定端口与真正可服务之间还有一大段启动过程。
    /// 就绪判据第一步：回环端口是否可连。与 localhttp::connect_local 同源
    /// （同一句 127.0.0.1 + to_socket_addrs + connect_timeout），此前这里另写一份，只有超时不同。
    pub(crate) fn port_open(port: u16) -> bool {
        super::localhttp::connect_local(port, std::time::Duration::from_millis(400)).is_some()
    }

pub(crate) fn ready(port: u16, http_timeout: std::time::Duration) -> Readiness {
    if !port_open(port) {
        return Readiness::PortClosed;
    }
    match crate::domain::localhttp::http_get_local(port, "/healthz", http_timeout) {
        Some((code, _)) if (200..300).contains(&code) => Readiness::Ready,
        Some((code, _)) => Readiness::Http(code),
        None => Readiness::NoHttpResponse,
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::time::Duration;

    fn fake_guard(reply: Option<&'static [u8]>) -> u16 {
        let l = TcpListener::bind("127.0.0.1:0").expect("假守卫应能绑定回环端口");
        let port = l.local_addr().expect("回环监听必有地址").port();
        let bytes = reply.map(|b| b.to_vec());
        std::thread::spawn(move || {
            for stream in l.incoming().flatten() {
                let bytes = bytes.clone();
                std::thread::spawn(move || {
                    let mut stream = stream;
                    let mut buf = [0u8; 256];
                    let _ = stream.read(&mut buf);
                    match bytes {
                        Some(b) => {
                            let _ = stream.write_all(&b);
                            let _ = stream.flush();
                        }
                        None => std::thread::sleep(std::time::Duration::from_secs(3)),
                    }
                });
            }
        });
        port
    }

    fn closed_port() -> u16 {
        let l = TcpListener::bind("127.0.0.1:0").expect("应能绑定回环端口");
        l.local_addr().expect("回环监听必有地址").port()
    }

    /// 就绪判据必须**分辨得出**四种现场 —— 它们的可操作结论完全不同：没起来（继续等）/ 起了但病了（看日志）/ 应答 5xx（真失败）/ 健康（放行）；只回 `bool` 会让它们变成同一句话。
    #[test]
    fn readiness_distinguishes_closed_healthz_and_sick() {
        assert_eq!(
            ready(fake_guard(Some(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok")), Duration::from_millis(600)),
            Readiness::Ready
        );
        assert_eq!(
            ready(
                fake_guard(Some(b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\n\r\n")),
                Duration::from_millis(600)
            ),
            Readiness::Http(503)
        );
        assert_eq!(
            ready(fake_guard(None), Duration::from_millis(300)),
            Readiness::NoHttpResponse
        );
        assert_eq!(ready(closed_port(), Duration::from_millis(300)), Readiness::PortClosed);
    }

    #[test]
    fn readiness_describe_is_not_a_single_string() {
        let all = [
            Readiness::Ready.describe(),
            Readiness::PortClosed.describe(),
            Readiness::Http(500).describe(),
            Readiness::NoHttpResponse.describe(),
        ];
        assert!(all[2].contains("500"), "HTTP 判定必须带状态码: {}", all[2]);
        let uniq: std::collections::HashSet<_> = all.iter().collect();
        assert_eq!(uniq.len(), 4, "四种判定文案不得撞车: {:?}", all);
    }


}


const READINESS_HTTP_TIMEOUT: std::time::Duration = std::time::Duration::from_millis(800);
