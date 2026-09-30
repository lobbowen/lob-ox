//! 环境探测记录的唯一所有者：维度表 `Probe`、记录形态 `Record`（`ok` 三态）、渲染（`render` / `json`）。
//! 新增维度只需在 `Probe` 登记并写一个探测函数，CLI、诊断串与面板自动跟上；否则同一条结论拆在三处各写一遍，
//! 漏改不报错。本文件不做网络 I/O（registry 只读 mirror::cached() 并写明是缓存），依赖维度按 TTL 复用缓存。
//! `ok = None` 是「无从判定」，与 Some(false)（判过且失败）两件事 —— 没有事实就不要伪造事实。

use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use crate::runtime_contract::NpmUsable;

/// 探针维度。这里是全壳唯一一份维度表：`as_str` 决定面板与 CLI 看到的名字。
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Probe {
    Node,
    Npm,
    Registry,
    Prefix,
}

impl Probe {
    pub fn as_str(self) -> &'static str {
        match self {
            Probe::Node => "node",
            Probe::Npm => "npm",
            Probe::Registry => "registry",
            Probe::Prefix => "prefix",
        }
    }
}

/// 一次探针的结论。
#[derive(Clone)]
pub struct Record {
    pub probe: Probe,
  /// 结论从哪来（候选来源 / 缓存名 / 命令）。
    pub source: String,
  /// 被探测的对象（路径、源 URL 或目录）。
    pub target: String,
    pub ms: u128,
  /// true=通过；false=判过且失败；None=无从判定。
    pub ok: Option<bool>,
  /// 版本、延迟或**失败原因**。失败时不得为空 —— 只报「缺失」等于把排障推给用户。
    pub note: String,
}

impl Record {
    pub fn new(
        probe: Probe,
        source: &str,
        target: String,
        ms: u128,
        ok: Option<bool>,
        note: impl Into<String>,
    ) -> Record {
        Record { probe, source: source.to_string(), target, ms, ok, note: note.into() }
    }

  /// 「某一步还没返回」的记录：卡住时的唯一线索，形态与失败不同（`ok = None`）。
  /// 旧实现把它记成 `ok = false`，于是诊断串里的「失败候选数」把在飞步骤也算成失败。
    pub fn pending(probe: Probe, source: &str, target: String, ms: u128, note: &str) -> Record {
        Record::new(probe, source, target, ms, None, note)
    }

    pub fn json(&self) -> serde_json::Value {
        serde_json::json!({
            "probe": self.probe.as_str(),
            "source": self.source,
            "target": self.target,
            "ms": self.ms,
            "ok": self.ok,
            "note": self.note,
        })
    }

  /// 一行文本渲染（CLI 与 `--self-check` 共用；面板拿 `json`，两者同源）。
    pub fn render(&self) -> String {
        let verdict = match self.ok {
            Some(true) => "ok",
            Some(false) => "no",
            None => "?",
        };
        format!(
            "  [{}] {} {} {} ms {} {}\n",
            self.probe.as_str(),
            self.source,
            self.target,
            self.ms,
            verdict,
            self.note
        )
    }
}

/// 把记录表渲染为多行文本（诊断 / CLI 自检用）。**唯一**的文本渲染出口。
pub fn render(records: &[Record]) -> String {
    let mut s = String::new();
    for r in records {
        s.push_str(&r.render());
    }
    s
}

/// npm 维度的结论：面板字段、契约落盘与失败文案**共用**这一个来源。
#[derive(Clone)]
pub struct NpmFact {
  /// 本轮是否看到了 node 可执行文件。false = npm 无从判定，必须报「未知」而不是「缺失」。
    pub node_seen: bool,
    pub usable: Option<NpmUsable>,
    pub why: Option<String>,
}

impl NpmFact {
  /// 三态：true=真实执行通过；false=有 node 但 npm 不可用；None=未取到 node，未知。
    pub fn ok(&self) -> Option<bool> {
        if !self.node_seen {
            return None;
        }
        Some(self.usable.is_some())
    }

    pub fn version(&self) -> Option<String> {
        self.usable.as_ref().map(|u| u.version.clone())
    }

    pub fn path(&self) -> Option<String> {
        self.usable.as_ref().map(|u| u.path.display().to_string())
    }
}

/// 一轮依赖探测的产物（node 之外的全部维度）。
#[derive(Clone)]
pub struct Snapshot {
    pub records: Vec<Record>,
    pub npm: NpmFact,
}

impl Snapshot {
  /// 探测线程本身没给出结论（panic / 任务被丢）：如实登记为「未知」，不冒充失败。
    pub fn aborted(why: &str) -> Snapshot {
        Snapshot {
            records: vec![Record::pending(Probe::Npm, "在飞线程", String::new(), 0, why)],
            npm: NpmFact { node_seen: false, usable: None, why: Some(why.to_string()) },
        }
    }
}

/// 依赖探测的复用窗口。取值口径：远小于「装完 Node 后引导页收敛」的可接受延迟，
/// 又远大于 400ms 轮询间隔；安装完成处另有显式 `invalidate_all()`，不靠窗口到期。
const DEPENDENT_TTL: Duration = Duration::from_secs(10);

struct Cached {
    at: Instant,
    node: Option<PathBuf>,
    snapshot: Snapshot,
}

fn cache() -> &'static Mutex<Option<Cached>> {
    static C: OnceLock<Mutex<Option<Cached>>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(None))
}

/// 依赖维度缓存失效。与 node 侧缓存**必须一起**作废 —— 见 `invalidate_all`。
fn invalidate() {
    if let Ok(mut g) = cache().lock() {
        *g = None;
    }
}

/// 作废**全部**环境事实缓存（node 候选 + 依赖维度）。node 安装/升级完成处调用。
///
/// 为什么是一个函数而不是两处各自调用：只失效一半会出现「新 Node + 旧 npm 结论」这种
/// 自相矛盾的快照，而它恰好出现在刚装完 Node 的那一刻 —— 引导页最需要正确结论的时候。
pub fn invalidate_all() {
    crate::nodeprobe::invalidate();
    invalidate();
}

/// 是否复用上一轮依赖结论。**纯判据**：换 node 必须重探，过期必须重探。
///
/// 为什么抽出来：这条判据只能靠真实探测（含子进程 + 系统时钟）验证的话，测试就是在猜时序 ——
/// 而它恰恰是「刚装完新 Node 却沿用旧 npm 结论」这类自相矛盾快照的唯一防线。
fn reusable(cached_node: &Option<PathBuf>, node: &Option<PathBuf>, age: Duration) -> bool {
    cached_node == node && age < DEPENDENT_TTL
}

/// node 之外全部维度的结论（同一 node 路径且未过 TTL 时复用缓存）。
pub fn dependents(node: Option<PathBuf>) -> Snapshot {
    {
        let g = match cache().lock() {
            Ok(g) => g,
            Err(e) => e.into_inner(),
        };
        if let Some(c) = g.as_ref() {
            if reusable(&c.node, &node, c.at.elapsed()) {
                let mut s = c.snapshot.clone();
                // registry 那一格绕过 TTL：它只是读一次内存里的预热快照，零成本。复用的话，
                // 预热完成后面板仍会念着 10 秒前的问号，而问号正是用户报的「看不到检测」。
                if let Some(r) = s.records.iter_mut().find(|r| r.probe == Probe::Registry) {
                    *r = registry_record();
                }
                return s;
            }
        }
    }
    let s = run_dependents(node.as_deref());
    if let Ok(mut g) = cache().lock() {
        *g = Some(Cached { at: Instant::now(), node, snapshot: s.clone() });
    }
    s
}

fn run_dependents(node: Option<&Path>) -> Snapshot {
    let (npm_record, npm) = probe_npm(node);
    let prefix_record = probe_prefix(&npm);
    Snapshot {
        records: vec![npm_record, registry_record(), prefix_record],
        npm,
    }
}

/// npm 可用性：委托 `runtime_contract::probe_npm_usable`（真实执行 `--version`，不变量 T-1b），
/// 且**只用本轮探测到的 node 路径**的兄弟目录 —— 否则「探针用的 npm」与「装内核用的 npm」
/// 可以不是同一个（T-10 同一条 spawn 路径）。
fn probe_npm(node: Option<&Path>) -> (Record, NpmFact) {
    let t0 = Instant::now();
    let Some(np) = node else {
        let why = "本次未探测到 node 路径，npm 无从判定".to_string();
        let r = Record::pending(Probe::Npm, "与 node 同源", String::new(), t0.elapsed().as_millis(), &why);
        return (r, NpmFact { node_seen: false, usable: None, why: Some(why) });
    };
    let Some(bin_dir) = np.parent() else {
        let why = format!("node 路径 {} 没有父目录", np.display());
        let r = Record::new(Probe::Npm, "与 node 同源", String::new(), t0.elapsed().as_millis(), Some(false), why.clone());
        return (r, NpmFact { node_seen: true, usable: None, why: Some(why) });
    };
    match crate::runtime_contract::probe_npm_usable(np, bin_dir) {
        Ok(u) => {
            let target = u.path.display().to_string();
            let r = Record::new(
                Probe::Npm,
                "与 node 同源",
                target,
                t0.elapsed().as_millis(),
                Some(true),
                u.version.clone(),
            );
            (r, NpmFact { node_seen: true, usable: Some(u), why: None })
        }
        Err(why) => {
  // note 就是原因本身（`npm_search_summary` 已把「找过哪些路径、为什么都不行」写全）。
            let r = Record::new(
                Probe::Npm,
                "与 node 同源",
                bin_dir.display().to_string(),
                t0.elapsed().as_millis(),
                Some(false),
                why.clone(),
            );
            (r, NpmFact { node_seen: true, usable: None, why: Some(why) })
        }
    }
}

/// npm registry 可达性：只读镜像**预热缓存**，故本维度零网络 I/O。
///
/// 为什么值得单独成一条记录：内核安装要连 npm 源，而「源不可达」在面板上此前只出现在
/// 诊断串的镜像片段里 —— 与环境探测结论分属两套文字，排障时对不上号。
fn registry_record() -> Record {
    let t0 = Instant::now();
    match crate::mirror::cached() {
        None => Record::pending(
            Probe::Registry,
            "镜像预热缓存",
            String::new(),
            t0.elapsed().as_millis(),
            "测速尚未完成（预热在飞或未启动）",
        ),
        Some(s) => {
            let ok = s.npm_probes.iter().any(|(_, o, _)| *o);
            let target = s.npm_best.clone().unwrap_or_else(|| {
                format!("{} 个候选源", s.npm_probes.len())
            });
            let note = match s.npm_latency_ms {
                Some(l) => format!("{}ms", l),
                None => "全部 npm 源不可达".to_string(),
            };
            Record::new(Probe::Registry, "镜像预热缓存", target, t0.elapsed().as_millis(), Some(ok), note)
        }
    }
}

/// npm 全局前缀的可写性 —— 内核安装真正落盘的那一步。EACCES/只读前缀会让
/// `npm install -g` 在跑了十几分钟之后才失败，而面板当时只剩一个退出码；一条 `prefix` 记录就能说清根因。
fn probe_prefix(npm: &NpmFact) -> Record {
    let t0 = Instant::now();
    let ms = || t0.elapsed().as_millis();
    let Some(u) = &npm.usable else {
        return Record::pending(
            Probe::Prefix,
            "npm prefix -g",
            String::new(),
            ms(),
            "npm 未通过可用性探针，全局前缀无从判定",
        );
    };
  // 与可用性探针同一条 spawn 路径：同一程序 + 同一前置参数，只换尾参。
    let dir = match crate::runtime_contract::run_npm_line(&u.path, &u.args, &["prefix", "-g"]) {
        Err(why) => return Record::new(Probe::Prefix, "npm prefix -g", String::new(), ms(), Some(false), why),
        Ok(line) => PathBuf::from(line.trim()),
    };
  // 先做盘符判定**再**碰这个目录：网络盘/UNC 上的 `exists()` 本身就可能是无界阻塞调用，
  // 那正是本仓反复消除的一类故障 —— 不能为了诊断卡死而引入新的卡死点。
    if !crate::env::is_local_fixed_dir(&dir) {
        return Record::pending(
            Probe::Prefix,
            "npm prefix -g",
            dir.display().to_string(),
            ms(),
            "不在本地固定盘，未做写入测试（网络盘/可移动盘的判定本身可能阻塞）",
        );
    }
    if !dir.exists() {
        return Record::pending(
            Probe::Prefix,
            "npm prefix -g",
            dir.display().to_string(),
            ms(),
            "目录尚不存在（安装时才创建，此刻无从验证可写性）",
        );
    }
    match write_probe(&dir) {
        Ok(()) => Record::new(Probe::Prefix, "npm prefix -g", dir.display().to_string(), ms(), Some(true), "目录可写"),
        Err(why) => Record::new(Probe::Prefix, "npm prefix -g", dir.display().to_string(), ms(), Some(false), why),
    }
}

/// 在目标目录里写一个唯一命名的探针文件再删掉 —— 权限（POSIX 位 / Windows ACL）只有
/// 真写一次才知道，`metadata()` 的只读位在 ACL 机器上会说谎。
fn write_probe(dir: &Path) -> Result<(), String> {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let probe = dir.join(format!(".dsh-supervisor-writability-{}-{}", std::process::id(), nanos));
    match std::fs::write(&probe, b"") {
        Ok(()) => {
  // 删不掉不是失败（前缀仍可写），但必须留在 note 之外由日志承担 ——
  // 此处静默删除失败，失败面比「写不进去」小得多。
            let _ = std::fs::remove_file(&probe);
            Ok(())
        }
        Err(e) => Err(format!("写入探针文件失败：{}", e)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

  /// 维度名是面板与 CLI 的公共词汇：改名必须**显式**发生在这里，而不是散在渲染里。
    #[test]
    fn probe_names_are_stable() {
        assert_eq!(Probe::Node.as_str(), "node");
        assert_eq!(Probe::Npm.as_str(), "npm");
        assert_eq!(Probe::Registry.as_str(), "registry");
        assert_eq!(Probe::Prefix.as_str(), "prefix");
    }

  /// 「未知」与「失败」必须在两种渲染下都可分辨 —— 把未知渲染成失败会触发无谓重装。
    #[test]
    fn unknown_is_not_failure_in_both_renders() {
        let r = Record::pending(Probe::Npm, "与 node 同源", String::new(), 3, "本次未探测到 node 路径");
        assert_eq!(r.json()["ok"], serde_json::Value::Null);
        assert!(r.render().contains(" ? "), "文本渲染必须带未知标记：{}", r.render());
        assert!(!r.render().contains(" no "), "未知不得渲染成失败：{}", r.render());
    }

  /// 失败记录必须自带原因（否则面板只能显示「npm 缺失」，三类根因无从分辨）。
    #[test]
    fn failure_record_carries_reason() {
        let r = Record::new(Probe::Npm, "s", "t".to_string(), 1, Some(false), "已查找 3 条路径");
        assert_eq!(r.json()["note"], "已查找 3 条路径");
        assert!(r.render().contains("已查找 3 条路径"));
    }

  /// npm 三态判据：node 未知时不得判失败。
    #[test]
    fn npm_fact_tri_state() {
        assert_eq!(NpmFact { node_seen: false, usable: None, why: None }.ok(), None);
        assert_eq!(
            NpmFact { node_seen: true, usable: None, why: Some("x".into()) }.ok(),
            Some(false)
        );
    }

    /// 本轮没探到 node 时，node 派生的维度必须是「未知」而不是「失败」：探测还在跑时把 npm
    /// 判成缺失，前端就会据此发起一次无根因的重装（与 T-1b 的放行同一纪律）。
    /// registry 与 node 无关（读镜像预热缓存），有结论是正当的 —— 本用例只锁「每个维度都留依据」，
    /// 不锁取值（否则就成了缓存状态的第二个事实源）。全程不 spawn 子进程、不碰网络。
    #[test]
    fn without_node_node_derived_dimensions_are_unknown() {
        let s = dependents(None);
        assert_eq!(s.records.len(), 3, "依赖维度必须齐（npm/registry/prefix）");
        for name in ["npm", "prefix"] {
            let r = s.records.iter().find(|x| x.probe.as_str() == name).expect("维度必须存在");
            assert_eq!(r.ok, None, "{} 维度在无 node 时不得给出结论: {:?}", name, r.note);
            assert!(!r.note.is_empty(), "未知也要说清为什么未知: {}", name);
        }
        let reg = s.records.iter().find(|x| x.probe.as_str() == "registry").expect("registry 维度必须存在");
        assert!(!reg.note.is_empty(), "registry 无论有无结论都必须留下依据");
        assert_eq!(s.npm.ok(), None);
        assert_eq!(s.npm.version(), None, "没执行过 npm 就不该有版本号");
        invalidate();
    }

  /// TTL 缓存的复用判据：换 node 必须重探，过期必须重探（否则探针就成了新的卡死源）。
    #[test]
    fn cache_key_includes_node_path() {
        let n = || Some(PathBuf::from("/opt/node/bin/node"));
        let m = || Some(PathBuf::from("/home/u/.dsh-node/bin/node"));
        let fresh = Duration::from_secs(1);
        assert!(reusable(&None, &None, fresh));
        assert!(reusable(&n(), &n(), fresh), "同一 node 路径应复用");
        assert!(!reusable(&None, &n(), fresh), "本轮有 node 却复用「无 node」的旧结论");
        assert!(!reusable(&n(), &m(), fresh), "换了 node 却复用上一台的结论");
        assert!(reusable(&None, &None, DEPENDENT_TTL - Duration::from_millis(1)));
        assert!(!reusable(&None, &None, DEPENDENT_TTL), "到界必须重探");
    }
}
