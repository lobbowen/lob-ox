//! 有界 Node 探测：探测内含无界阻塞系统调用，故分离线程执行 + 边枚举边上报 stage + 硬上限。
//! 规则一：任何可能阻塞的调用之前都必须先 stage()（候选枚举、盘符判定、目录读取都算），否则卡住时看不见线索。
//! 规则二：Rust 侧硬上限（HARD_DEADLINE）超过即判明确失败并返回原因，即使某系统调用永久挂起，命令也一定给出结论。
//! 本文件刻意不使用反引号与单引号字面量（用数值 92/58 表达反斜杠与冒号），以免跨格式传递时被转义破坏。

use std::path::{Path, PathBuf};
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError, Sender};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use crate::domain::probes::{Probe, Record};

/// 一次探测的结论。
///
/// `records` 只有 `Probe::Node` 一个维度：npm / registry / prefix 是它的**下游**，
///   由 `domain::probes::dependents` 在同一份命令输出里补齐（那里按 TTL 复用缓存）。
#[derive(Clone)]
pub struct Outcome {
    pub path: Option<PathBuf>,
    pub version: Option<String>,
    pub records: Vec<Record>,
    pub elapsed_ms: u128,
    /// true = 本次探测已结束（成功或明确失败）；false = 仍在进行（phase 快照）。
    pub finished: bool,
    /// 明确失败的原因（finished=true 且未找到时必有值）。
    pub error: Option<String>,
}

struct Live {
    current: Option<(String, Instant)>,
    done: Vec<Record>,
    summary: String,
}

fn live() -> &'static Mutex<Live> {
    static L: OnceLock<Mutex<Live>> = OnceLock::new();
    L.get_or_init(|| Mutex::new(Live { current: None, done: Vec::new(), summary: String::new() }))
}

/// 取活进度锁。毒锁里的 `Live` 仍是完好结构体：读者本就容毒读，写方若因毒丢写，
/// UI 会永久停在最后一条 `current` 上再也得不到更新 —— 而那条恰恰是「卡住时唯一线索」。
fn live_lock() -> std::sync::MutexGuard<'static, Live> {
    live().lock().unwrap_or_else(|e| e.into_inner())
}

thread_local! {
    /// 本线程所属探测代际；`None` = 不是 worker 线程（命令线程与测试直调），其写入不受代际约束。
    static WORKER_GEN: std::cell::Cell<Option<u64>> = std::cell::Cell::new(None);
}

/// 已被作废的 worker 是否还在写共享进度。
///
/// 代际校验原先只挡最终回写，于是被作废的旧 worker 在 `detect()` 里继续 stage/finish，
/// 新一代面板读到的是上一轮留下的「正在做什么」与记录 —— 卡住线索被串扰成假现场。
fn stale_writer() -> bool {
    WORKER_GEN.with(|g| {
        g.get().map_or(false, |gen| gen != GENERATION.load(std::sync::atomic::Ordering::SeqCst))
    })
}

fn live_reset() {
    if stale_writer() { return; }
    let mut l = live_lock();
    l.current = None;
    l.done.clear();
}

/// 标记「即将做一件可能阻塞的事」。**调用它必须在任何 I/O 之前**（规则一）。
fn stage(desc: &str) {
    if stale_writer() { return; }
    live_lock().current = Some((desc.to_string(), Instant::now()));
}

fn finish(entry: Record) {
    if stale_writer() { return; }
    let mut l = live_lock();
    l.current = None;
    l.done.push(entry);
}

fn set_summary(s: String) {
    if stale_writer() { return; }
    let mut l = live_lock();
    l.summary = s;
}

fn snapshot() -> Vec<Record> {
    live_lock().done.clone()
}

/// 当前正在做哪一步、已耗时多久。**卡住时的唯一线索。**
pub fn current_stuck() -> Option<(String, u128)> {
    let l = live_lock();
    let (s, t) = l.current.as_ref()?;
    Some((s.clone(), t.elapsed().as_millis()))
}

/// 候选摘要（**只读缓存，不做任何 I/O**）。由探测线程在枚举完成后写入。
pub fn candidate_summary() -> String {
    live_lock().summary.clone()
}

/// 在飞探测的实时状态（与 Outcome 分离：即使探测永不返回，也能读到进展）。
const STALE_AFTER: Duration = Duration::from_secs(90);

/// **硬上限**（规则二）：超过即判定本次探测明确失败并给出原因。
/// 若没有它，某系统调用永久挂起时前端只能等自己的预算耗尽，结论只剩一句无信息量的「超时」；
/// 有它，命令会主动返回「卡在 <阶段> 已 N 秒」，用户与排障都能直接定位。
/// 取值毫秒；运行时可变仅为测试可注入，正式路径恒为 25000。
static HARD_DEADLINE_MS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(25_000);

fn hard_deadline() -> Duration {
    Duration::from_millis(HARD_DEADLINE_MS.load(std::sync::atomic::Ordering::Relaxed))
}

/** 仅供测试：注入硬上限。 */
#[cfg(test)]
pub fn set_hard_deadline_ms(ms: u64) {
    HARD_DEADLINE_MS.store(ms, std::sync::atomic::Ordering::Relaxed);
}

/** 仅供测试：让候选枚举阶段永久阻塞，用于验证「卡住时一定给出带阶段的结论」。 */
#[cfg(test)]
static HANG_IN_ENUMERATE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

#[cfg(test)]
pub fn set_hang_in_enumerate(v: bool) {
    HANG_IN_ENUMERATE.store(v, std::sync::atomic::Ordering::Relaxed);
}

enum State {
    Idle,
    Running(Option<Receiver<Outcome>>, Instant),
    Done(Outcome),
}

fn state() -> &'static Mutex<State> {
    static S: OnceLock<Mutex<State>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(State::Idle))
}

/// 使缓存失效（Node 安装完成后调用）。
pub fn invalidate() {
    if let Ok(mut g) = state().lock() {
        // 显式复位：作废旧代际（防旧 worker 回写诊断）、清孤儿计数（允许重新探测）。
        // 注：旧 worker 若仍在运行，线程本身依然存在（Rust 无法强制回收），
        //     但此处是「用户/安装流程显式要求重来」的语义，故接受重新开始。
        GENERATION.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        ORPHANS.store(0, std::sync::atomic::Ordering::SeqCst);
        *g = State::Idle;
    }
}

/// 阶段快照（探测未完成，但尚未到硬上限）。
pub fn partial() -> Outcome {
    let mut records = snapshot();
    if let Some((desc, ms)) = current_stuck() {
        // 在飞的步骤记 `ok = None`（未知），不是失败：把它算进失败候选数会让
        // 「还有一个候选没试完」看起来像「这个候选坏了」。
        records.push(Record::pending(
            Probe::Node,
            "进行中",
            desc,
            ms,
            "该步骤尚未返回（若为 I/O 步骤，可能被系统调用阻塞）",
        ));
    }
    Outcome { path: None, version: None, records, elapsed_ms: 0, finished: false, error: None }
}

/// 明确失败（带原因与已收集的记录）。
fn failed(reason: String, elapsed_ms: u128) -> Outcome {
    let mut records = snapshot();
    if let Some((desc, ms)) = current_stuck() {
        records.push(Record::pending(
            Probe::Node,
            "卡住",
            desc.clone(),
            ms,
            &format!("该步骤已 {} ms 无响应", ms),
        ));
    }
    Outcome { path: None, version: None, records, elapsed_ms, finished: true, error: Some(reason) }
}

/// 取探测结论，绝不阻塞超过 budget。返回分三种：
/// 正常完成；仍在进行（finished=false，由前端轮询）；明确失败（到硬上限或工作线程异常）。
pub fn status(budget: Duration) -> Outcome {
    // 决定「复用 / 重启 / 新建」在飞探测（持锁但几乎不耗时）
    let started_at;
    {
        let mut g = match state().lock() {
            Ok(g) => g,
            Err(e) => e.into_inner(),
        };
        match &mut *g {
            State::Done(o) => return o.clone(),
            State::Running(rx, started) => {
                if started.elapsed() >= STALE_AFTER {
                    let (tx, rx2) = channel();
                    abandon_current_worker(); // 旧 worker 仍在跑，记孤儿并作废其代际
                    live_reset();
                    spawn_worker(tx);
                    *rx = Some(rx2);
                    *started = Instant::now();
                }
                started_at = *started;
            }
            State::Idle => {
                // P2：若上一次的 worker 仍未退出（卡在无界系统调用），**不再新建** ——
                //   否则用户每点一次「重试」就多一条永不退出的线程。此时给出明确结论，
                //   等旧 worker 退出（或 invalidate() 显式复位）后即可重新探测。
                if ORPHANS.load(std::sync::atomic::Ordering::SeqCst) > 0 {
                    return failed(
                        "上一次环境探测仍未退出（线程卡在系统调用中，无法回收）；已跳过重复启动，避免线程堆积"
                            .to_string(),
                        0,
                    );
                }
                let (tx, rx) = channel();
                live_reset();
                // 规则一：在启动探测前先标记阶段 —— 线程调度本身也可能延迟，
                // 若此处不标记，前端会看到「probing 但没有任何阶段」，与卡死无法区分。
                stage("启动探测线程");
                spawn_worker(tx);
                let now = Instant::now();
                *g = State::Running(Some(rx), now);
                started_at = now;
            }
        }
    }

    // 取出 receiver 等待（不持锁阻塞，避免与 invalidate 等调用相互影响）
    let rx = {
        let mut g = match state().lock() {
            Ok(g) => g,
            Err(e) => e.into_inner(),
        };
        match &mut *g {
            State::Running(rx, _) => rx.take(),
            State::Done(o) => return o.clone(),
            State::Idle => None,
        }
    };
    let Some(rx) = rx else {
        return partial();
    };

    let res = rx.recv_timeout(budget);

    let mut g = match state().lock() {
        Ok(g) => g,
        Err(e) => e.into_inner(),
    };
    match res {
        Ok(o) => {
            *g = State::Done(o.clone());
            o
        }
        Err(RecvTimeoutError::Timeout) => {
            if started_at.elapsed() >= hard_deadline() {
                // 规则二：主动给出明确失败，而不是让 probing 永远为真。
                // 同时回到 Idle，让「重试」能重新开始一次干净探测。
                let el = started_at.elapsed().as_millis();
                let where_ = current_stuck()
                    .map(|(d, ms)| format!("卡在「{}」已 {} ms", d, ms))
                    .unwrap_or_else(|| "探测线程未报告任何阶段".to_string());
                // 作废该 worker 并记孤儿（它仍在卡死中，无法回收）；
                // 之后 status() 在孤儿未退出前不会再新建线程（见 Idle 分支）。
                abandon_current_worker();
                *g = State::Idle;
                failed(
                    format!(
                        "环境探测超过 {} ms 未完成（{}）；该探测线程已作废且无法回收，当前未退出孤儿线程数={}",
                        hard_deadline().as_millis(),
                        where_,
                        orphan_count()
                    ),
                    el,
                )
            } else {
                if let State::Running(slot, _) = &mut *g {
                    *slot = Some(rx);
                }
                partial()
            }
        }
        Err(RecvTimeoutError::Disconnected) => {
            // 工作线程异常结束（不应发生）：明确失败，而不是静默停在 probing。
            let el = started_at.elapsed().as_millis();
            *g = State::Idle;
            failed("探测线程异常退出".to_string(), el)
        }
    }
}

/// 触发探测但不等待（UI 启动时预热）。
pub fn start() {
    let _ = status(Duration::from_millis(1));
}

/// 便捷入口：在有界预算内尽力取回结论。
pub fn resolve(budget: Duration) -> Option<(PathBuf, String)> {
    let out = status(budget);
    match (out.path, out.version) {
        (Some(p), Some(v)) => Some((p, v)),
        _ => None,
    }
}

/// 探测**代际**：每次新建 worker 自增。worker 回写诊断前比对代际，
/// 保证「已作废的旧 worker」不会把记录写进新一轮探测（防诊断串被污染）。
static GENERATION: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// 已被作废但尚未退出的 worker 数量（不可回收的线程）。
/// worker 卡在无界阻塞系统调用时，Rust 无法回收线程；若超限后直接重来，每次「重试」都会多堆一条永不退出的线程。
/// 故：代际作废防旧 worker 回写污染；计数孤儿并在其退出前不再新建（重试得到明确结论而非默默开线程）；
/// invalidate() 是显式复位口（安装成功后 / 测试复位）。
static ORPHANS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// 作废当前 worker 并记为孤儿（它仍在运行、无法回收）。
fn abandon_current_worker() {
    GENERATION.fetch_add(1, std::sync::atomic::Ordering::SeqCst); // 使旧 worker 退出时不回写诊断
    ORPHANS.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
}

/// 当前未退出的孤儿 worker 数（诊断用；不改变行为）。
pub fn orphan_count() -> u64 {
    ORPHANS.load(std::sync::atomic::Ordering::SeqCst)
}

fn spawn_worker(tx: Sender<Outcome>) {
    let gen = GENERATION.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
    let _ = std::thread::Builder::new()
        .name("node-probe".to_string())
        .spawn(move || {
            WORKER_GEN.with(|g| g.set(Some(gen)));
            let started = Instant::now();
            // 最后一道保险：worker 内 panic 也必须产出结论，否则线程静默死亡、命令只能一直报 probing。
            let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(detect));
            // 代际校验：若本轮已被作废（GENERATION 前进），则**不回写诊断**，
            // 仅统计孤儿退出，避免污染新一轮的记录与候选摘要。
            if GENERATION.load(std::sync::atomic::Ordering::SeqCst) != gen {
                // 饱和减（invalidate() 可能已把计数清零；绝不能下溢成天文数字）
                let _ = ORPHANS.fetch_update(
                    std::sync::atomic::Ordering::SeqCst,
                    std::sync::atomic::Ordering::SeqCst,
                    |v| Some(v.saturating_sub(1)),
                );
                return;
            }
            let outcome = match r {
                Ok((path, version, err)) => Outcome {
                    path,
                    version,
                    records: snapshot(),
                    elapsed_ms: started.elapsed().as_millis(),
                    finished: true,
                    error: err,
                },
                Err(_) => Outcome {
                    path: None,
                    version: None,
                    records: snapshot(),
                    elapsed_ms: started.elapsed().as_millis(),
                    finished: true,
                    error: Some("探测过程内部异常（已捕获，未静默）".to_string()),
                },
            };
            let _ = tx.send(outcome);
        });
}

/// 返回 (路径, 版本, 明确失败原因)。
/// 边枚举边探测、最可能慢的 PATH 放最后：若先全部枚举再探测，枚举一慢/卡，已枚举好的廉价候选也永远试不到。
/// 于是 Node 装在标准位置的多数用户在 1) 或 2) 即命中，根本走不到 PATH 过滤——不上报不如不调用。
fn detect() -> (Option<PathBuf>, Option<String>, Option<String>) {
    #[cfg(test)]
    if HANG_IN_ENUMERATE.load(std::sync::atomic::Ordering::Relaxed) {
        // 精确复刻线上故障：卡在枚举阶段。
        // 若此处不 stage，诊断串里候选摘要 / 卡住阶段 / 探测记录会同时为空 ——
        // 即用户看到的「卡住且不报错、也没有任何线索」。
        stage("测试：模拟枚举阶段永久阻塞");
        std::thread::sleep(Duration::from_secs(10));
    }
    let mut out: Vec<(String, PathBuf)> = Vec::new();
    let add = |src: &str, p: PathBuf, out: &mut Vec<(String, PathBuf)>| -> bool {
        if out.iter().any(|(_, e)| *e == p) {
            return false;
        }
        out.push((src.to_string(), p));
        true
    };

    // 1) 自己记录的路径（一次本地读；最廉价也最可信）
    stage("① 读取 runtime.json 记录路径");
    if let Some(p) = crate::env::recorded_node_path() {
        if add("记录", p.clone(), &mut out) {
            if let Some(v) = try_probe("记录", &p) {
                set_summary(summarize(&out));
                return (Some(p), Some(v), None);
            }
        }
    }
    set_summary(format!("{}（进行中：① 已试）", summarize(&out)));

    // 2) 已知安装落点（逐个：列一个、试一个）
    stage("② 枚举已知安装落点");
    for (src, p) in known_locations() {
        if !add(&src, p.clone(), &mut out) {
            continue;
        }
        set_summary(format!("{}（进行中：② 搜索中）", summarize(&out)));
        if let Some(v) = try_probe(&src, &p) {
            set_summary(summarize(&out));
            return (Some(p), Some(v), None);
        }
    }

    // 3) PATH（最后：这是唯一需要逐盘符系统调用的阶段）
    let dirs = path_dirs_staged();
    let total = dirs.len();
    set_summary(format!("{}（进行中：③ PATH 已过滤 {} 条）", summarize(&out), total));
    for (i, dir) in dirs.into_iter().enumerate() {
        let cand = dir.join(crate::env::node_exe());
        if !add("PATH", cand.clone(), &mut out) {
            continue;
        }
        stage(&format!("③ 探测 PATH 候选 {}/{}", i + 1, total));
        if let Some(v) = try_probe("PATH", &cand) {
            set_summary(summarize(&out));
            return (Some(cand), Some(v), None);
        }
    }

    set_summary(summarize(&out));
    (None, None, None)
}

/// 探测单个候选：stage -> 可用性判定 -> 执行取版本 -> 落一条 `Probe::Node` 记录。返回版本（成功时）。
fn try_probe(source: &str, cand: &Path) -> Option<String> {
    let p = cand.to_string_lossy().to_string();
    stage(&format!("探测候选 {}（{}）", source, p));
    let t0 = Instant::now();
    let ms = || t0.elapsed().as_millis();
    if !crate::env::is_usable_candidate(cand) {
        finish(Record::new(
            Probe::Node,
            source,
            p,
            ms(),
            Some(false),
            "不可用（不存在 / 应用别名存根 / 空文件）",
        ));
        return None;
    }
    match crate::env::node_version(cand) {
        Some(v) => {
            finish(Record::new(Probe::Node, source, p, ms(), Some(true), v.clone()));
            Some(v)
        }
        None => {
            finish(Record::new(
                Probe::Node,
                source,
                p,
                ms(),
                Some(false),
                "无响应或不是有效 Node（已按上限终止）",
            ));
            None
        }
    }
}

fn summarize(c: &[(String, PathBuf)]) -> String {
    let recorded = c.iter().filter(|(s, _)| s == "记录").count();
    let known = c.iter().filter(|(s, _)| s == "已知").count();
    let path = c.iter().filter(|(s, _)| s == "PATH").count();
    format!("候选 {} 个（记录 {} / 已知 {} / PATH {}）", c.len(), recorded, known, path)
}


/// PATH 目录，逐条 stage 并做本地盘过滤（过滤本身也可能阻塞 —— 见 env.rs 的盘符缓存）。
fn path_dirs_staged() -> Vec<PathBuf> {
    /// PATH 条目上限：极端长的 PATH 不应把探测拖成分钟级。
    const MAX_PATH_ENTRIES: usize = 64;
    stage("③ 过滤 PATH（跳过网络盘/UNC）");
    let mut v = crate::env::path_dirs_local_only();
    if v.len() > MAX_PATH_ENTRIES {
        v.truncate(MAX_PATH_ENTRIES);
    }
    v
}

/// 已知安装落点（平台判定），实现下沉在 platform 层：Unix 为 /usr/local、/opt/homebrew、volta/nvm/fnm 布局；
/// Windows 为 ProgramFiles(x86)、Chocolatey、scoop、volta、nvm 等。
/// Windows 不得硬编码 `C:\Program Files`：真实路径随系统盘符与系统语言变化，一律经环境变量推导。
/// 内部会做 read_dir（版本管理器布局需枚举版本目录），可能落在漫游配置/慢速盘 - 调用方必须先 stage() 上报。
fn known_locations() -> Vec<(String, PathBuf)> {
    crate::platform::current()
        .node_candidate_paths()
        .into_iter()
        .map(|p| ("已知".to_string(), p))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 这两个用例共享全局注入（挂起标志 + 硬上限），必须串行执行，
    /// 否则并行时一个用例的注入会污染另一个。
    static SERIAL: Mutex<()> = Mutex::new(());

    /// 核心性质：枚举阶段永久阻塞时，必须给出带阶段信息的明确结论。
    /// 对应故障形态：卡在枚举（GetDriveTypeW / read_dir），而候选摘要 / 卡住阶段 / 探测记录全空。
    #[test]
    fn hard_deadline_yields_actionable_failure_when_enumeration_hangs() {
        let _guard = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        set_hard_deadline_ms(500);
        invalidate();
        set_hang_in_enumerate(true);

        let t0 = Instant::now();
        // 第一次：仍在进行，但**阶段必须可见**（规则一已生效）
        let first = status(Duration::from_millis(30));
        assert!(!first.finished, "首查不应立刻结束");
        let stuck = current_stuck();
        assert!(stuck.is_some(), "卡住时必须能看到当前阶段（否则无从排障）");
        assert!(
            stuck.as_ref().unwrap().0.contains("模拟枚举"),
            "阶段名未反映真实位置: {:?}",
            stuck
        );

        // 持续轮询：应在硬上限附近得到**明确失败**，而不是永远 probing
        let mut last = first;
        while !last.finished && t0.elapsed() < Duration::from_secs(20) {
            std::thread::sleep(Duration::from_millis(50));
            last = status(Duration::from_millis(30));
        }
        assert!(last.finished, "超过硬上限仍未给出结论 —— 这正是要消除的故障");
        let err = last.error.clone().expect("明确失败必须带原因");
        assert!(err.contains("未完成"), "原因应说明超限: {}", err);
        assert!(err.contains("模拟枚举"), "原因必须包含卡住的阶段: {}", err);
        assert!(!last.records.is_empty(), "记录不应为空（诊断串要用）");
        assert!(
            last.records.iter().any(|r| r.ok.is_none()),
            "卡住的那一步必须以「未知」形态留在记录里（否则无从排障）"
        );

        set_hang_in_enumerate(false);
        set_hard_deadline_ms(25_000);
        invalidate();
    }

    /// P2 门禁：孤儿 worker 未退出前不得再新建（防线程堆积）。
    /// 若超限后把状态直接置回 Idle，用户每点一次「重试」就多一条永不退出的线程；
    /// 修法：作废时记孤儿，孤儿未退出前 Idle 分支拒绝新建并给出明确结论。
    /// 断言：越过硬上限后连续多次 status() 不得让孤儿计数继续增长。
    #[test]
    fn orphan_workers_do_not_accumulate_on_repeated_retry() {
        let _guard = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        set_hard_deadline_ms(400);
        invalidate();
        assert_eq!(orphan_count(), 0, "invalidate 应清零孤儿计数");
        set_hang_in_enumerate(true);

        let t0 = Instant::now();
        let mut last = status(Duration::from_millis(30));
        while !last.finished && t0.elapsed() < Duration::from_secs(20) {
            std::thread::sleep(Duration::from_millis(40));
            last = status(Duration::from_millis(30));
        }
        assert!(last.finished, "越过硬上限必须给出结论");
        let after_first = orphan_count();
        assert_eq!(after_first, 1, "首次超限应恰好产生 1 个孤儿，实得 {}", after_first);

        // 反复重试：孤儿仍未退出，必须拒绝新建（计数不得增长）
        for i in 0..6 {
            let o = status(Duration::from_millis(30));
            assert!(o.finished, "第 {} 次重试应立刻给出结论（不再新建线程）", i + 1);
            let err = o.error.clone().unwrap_or_default();
            assert!(
                err.contains("跳过重复启动") || err.contains("仍未退出"),
                "第 {} 次重试的结论应说明为何不新建：{}",
                i + 1,
                err
            );
        }
        assert_eq!(
            orphan_count(),
            after_first,
            "反复重试后孤儿数不得增长（旧实现每次 +1）"
        );

        set_hang_in_enumerate(false);
        set_hard_deadline_ms(25_000);
        invalidate();
        assert_eq!(orphan_count(), 0, "invalidate 后应可重新探测");
    }

    /// 注入未开启时，正常探测必须完成（确认测试钩子未污染正常路径）。
    #[test]
    fn normal_probe_completes() {
        let _guard = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        set_hang_in_enumerate(false);
        invalidate();
        let out = status(Duration::from_secs(30));
        assert!(out.finished, "正常探测应完成");
        assert!(out.error.is_none(), "正常探测不应报错: {:?}", out.error);
        invalidate();
    }
}
