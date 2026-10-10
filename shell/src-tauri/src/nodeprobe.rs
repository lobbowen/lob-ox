use std::path::{Path, PathBuf};
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError, Sender};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use crate::domain::probes::{Probe, Record};

#[derive(Clone)]
pub struct Outcome {
    pub path: Option<PathBuf>,
    pub version: Option<String>,
    pub records: Vec<Record>,
    pub elapsed_ms: u128,
    pub finished: bool,
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

fn live_lock() -> std::sync::MutexGuard<'static, Live> {
    live().lock().unwrap_or_else(|e| e.into_inner())
}

thread_local! {
    static WORKER_GEN: std::cell::Cell<Option<u64>> = std::cell::Cell::new(None);
}

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

pub fn current_stuck() -> Option<(String, u128)> {
    let l = live_lock();
    let (s, t) = l.current.as_ref()?;
    Some((s.clone(), t.elapsed().as_millis()))
}

pub fn candidate_summary() -> String {
    live_lock().summary.clone()
}

const STALE_AFTER: Duration = Duration::from_secs(90);

static HARD_DEADLINE_MS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(25_000);

fn hard_deadline() -> Duration {
    Duration::from_millis(HARD_DEADLINE_MS.load(std::sync::atomic::Ordering::Relaxed))
}

#[cfg(test)]
pub fn set_hard_deadline_ms(ms: u64) {
    HARD_DEADLINE_MS.store(ms, std::sync::atomic::Ordering::Relaxed);
}

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

pub fn invalidate() {
    if let Ok(mut g) = state().lock() {
        GENERATION.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        ORPHANS.store(0, std::sync::atomic::Ordering::SeqCst);
        *g = State::Idle;
    }
}

pub fn partial() -> Outcome {
    let mut records = snapshot();
    if let Some((desc, ms)) = current_stuck() {
                
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

pub fn status(budget: Duration) -> Outcome {
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
                    abandon_current_worker();
                    live_reset();
                    spawn_worker(tx);
                    *rx = Some(rx2);
                    *started = Instant::now();
                }
                started_at = *started;
            }
            State::Idle => {
                                
                if ORPHANS.load(std::sync::atomic::Ordering::SeqCst) > 0 {
                    return failed(
                        "上一次环境探测仍未退出（线程卡在系统调用中，无法回收）；已跳过重复启动，避免线程堆积"
                            .to_string(),
                        0,
                    );
                }
                let (tx, rx) = channel();
                live_reset();
                stage("启动探测线程");
                spawn_worker(tx);
                let now = Instant::now();
                *g = State::Running(Some(rx), now);
                started_at = now;
            }
        }
    }

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
                let el = started_at.elapsed().as_millis();
                let where_ = current_stuck()
                    .map(|(d, ms)| format!("卡在「{}」已 {} ms", d, ms))
                    .unwrap_or_else(|| "探测线程未报告任何阶段".to_string());
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
            let el = started_at.elapsed().as_millis();
            *g = State::Idle;
            failed("探测线程异常退出".to_string(), el)
        }
    }
}

pub fn start() {
    let _ = status(Duration::from_millis(1));
}

pub fn resolve(budget: Duration) -> Option<(PathBuf, String)> {
    let out = status(budget);
    match (out.path, out.version) {
        (Some(p), Some(v)) => Some((p, v)),
        _ => None,
    }
}

static GENERATION: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

static ORPHANS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

fn abandon_current_worker() {
    GENERATION.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    ORPHANS.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
}

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
                        
            let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(detect));
                        
            if GENERATION.load(std::sync::atomic::Ordering::SeqCst) != gen {
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

fn detect() -> (Option<PathBuf>, Option<String>, Option<String>) {
    #[cfg(test)]
    if HANG_IN_ENUMERATE.load(std::sync::atomic::Ordering::Relaxed) {
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

        
        
        
        
        
    stage("①b 询问系统 PATH 上的 Node");
    if let Some(p) = crate::env::find_in_path(crate::env::node_exe()) {
        if add("PATH", p.clone(), &mut out) {
            if let Some(v) = try_probe("PATH", &p) {
                set_summary(summarize(&out));
                return (Some(p), Some(v), None);
            }
        }
    }

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

fn path_dirs_staged() -> Vec<PathBuf> {
        
    const MAX_PATH_ENTRIES: usize = 64;
    stage("③ 过滤 PATH（跳过网络盘/UNC）");
    let mut v = crate::env::path_dirs_local_only();
    if v.len() > MAX_PATH_ENTRIES {
        v.truncate(MAX_PATH_ENTRIES);
    }
    v
}

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

        
    static SERIAL: Mutex<()> = Mutex::new(());

        
    #[test]
    fn hard_deadline_yields_actionable_failure_when_enumeration_hangs() {
        let _guard = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        set_hard_deadline_ms(500);
        invalidate();
        set_hang_in_enumerate(true);

        let t0 = Instant::now();
        let first = status(Duration::from_millis(30));
        assert!(!first.finished, "首查不应立刻结束");
        let stuck = current_stuck();
        assert!(stuck.is_some(), "卡住时必须能看到当前阶段（否则无从排障）");
        assert!(
            stuck.as_ref().unwrap().0.contains("模拟枚举"),
            "阶段名未反映真实位置: {:?}",
            stuck
        );

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
