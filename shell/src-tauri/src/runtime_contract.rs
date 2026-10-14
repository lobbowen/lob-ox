use std::path::{Path, PathBuf};

pub const SCHEMA: u32 = 2;

#[derive(Clone, Debug)]
pub struct NodeRuntime {
    pub node: PathBuf,
    pub node_bin_dir: PathBuf,
    pub npm: PathBuf,
        
    pub npm_prefix: Vec<String>,
    pub version: String,
        
    pub npm_version: Option<String>,
}

impl NodeRuntime {
    pub fn npm_version_label(&self) -> String {
        self.npm_version.clone().unwrap_or_else(|| "版本未回读".into())
    }
}

pub fn path() -> PathBuf {
    crate::env::supervisor_dir().join("runtime.json")
}

pub fn npm_shim_candidates(bin_dir: &Path) -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> = Vec::new();
    for name in [
        crate::platform::current().npm_exe_name(),
        "npm",
        "npm.cmd",
        "npm.exe",
    ] {
        let p = bin_dir.join(name);
        if !v.contains(&p) {
            v.push(p);
        }
    }
    v
}

pub fn npm_cli_js(bin_dir: &Path) -> PathBuf {
    bin_dir
        .join("node_modules")
        .join("npm")
        .join("bin")
        .join("npm-cli.js")
}

pub fn probe_npm(node: &Path, bin_dir: &Path) -> Option<(PathBuf, Vec<String>)> {
    let plat = crate::platform::current();
    for p in npm_shim_candidates(bin_dir) {
        if p.is_file() && plat.is_directly_spawnable(&p) {
            return Some((p, vec![]));
        }
    }
    let cli = npm_cli_js(bin_dir);
    if cli.is_file() {
        return Some((node.to_path_buf(), vec![cli.display().to_string()]));
    }
    None
}

pub fn npm_unspawnable_hint() -> &'static str {
    "npm 垫片在本平台不可直接执行（CreateProcessW 只认可执行程序，.cmd/.bat/sh 脚本除外）——\
     需随 Node 一起提供 node_modules/npm/bin/npm-cli.js"
}

pub fn derive(node: &Path, version: &str) -> Option<NodeRuntime> {
    let node_bin_dir = node.parent()?.to_path_buf();
    let (npm, npm_prefix) = probe_npm(node, &node_bin_dir)?;
    Some(NodeRuntime {
        node: node.to_path_buf(),
        node_bin_dir,
        npm,
        npm_prefix,
        version: version.to_string(),
        npm_version: None,
    })
}

pub fn npm_search_summary(bin_dir: &Path) -> String {
    let searched: Vec<String> = {
        let mut v: Vec<String> = npm_shim_candidates(bin_dir)
            .iter()
            .map(|p| p.display().to_string())
            .collect();
        v.push(npm_cli_js(bin_dir).display().to_string());
        v
    };
    let on_disk = npm_shim_candidates(bin_dir)
        .into_iter()
        .filter(|p| p.is_file())
        .count();
    let why = if on_disk > 0 {
        npm_unspawnable_hint().to_string()
    } else {
        "以上路径均不存在（npm 未随本机 Node 一起提供）".to_string()
    };
    format!("已查找 {}；{}", searched.join("、"), why)
}

#[derive(Clone)]
pub struct NpmUsable {
    pub path: PathBuf,
    pub args: Vec<String>,
    pub version: String,
}

pub fn probe_npm_usable(node: &Path, bin_dir: &Path) -> Result<NpmUsable, String> {
    let (path, args) = match probe_npm(node, bin_dir) {
        Some(x) => x,
        None => return Err(npm_search_summary(bin_dir)),
    };
    let version = run_npm_line(&path, &args, &["--version"])
        .map_err(|why| format!("{}：{}", path.display(), why))?;
    Ok(NpmUsable { path, args, version })
}

const NPM_PROBE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(8);

pub fn run_npm_line(prog: &Path, args: &[String], tail: &[&str]) -> Result<String, String> {
    let mut cmd = std::process::Command::new(prog);
    cmd.args(args).args(tail);
    let out = crate::bounded::run(&mut cmd, NPM_PROBE_TIMEOUT)?;
    if !out.success {
        return Err(out.failure(&format!("npm {} 探针未通过", tail.join(" "))));
    }
    out.stdout
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .map(String::from)
        .ok_or_else(|| format!("npm {} 执行成功但没有任何输出", tail.join(" ")))
}

pub fn usable_runtime(node: &Path, version: &str, npm: &NpmUsable) -> Option<NodeRuntime> {
    Some(NodeRuntime {
        node: node.to_path_buf(),
        node_bin_dir: node.parent()?.to_path_buf(),
        npm: npm.path.clone(),
        npm_prefix: npm.args.clone(),
        version: version.to_string(),
        npm_version: Some(npm.version.clone()),
    })
}

pub fn derive_usable(node: &Path, version: &str) -> Option<NodeRuntime> {
    let bin_dir = node.parent()?;
    let u = probe_npm_usable(node, bin_dir).ok()?;
    usable_runtime(node, version, &u)
}

fn meta(rt: &NodeRuntime) -> serde_json::Value {
    let node_s = rt.node.display().to_string();
    let bin_s = rt.node_bin_dir.display().to_string();
    let npm_s = rt.npm.display().to_string();
    serde_json::json!({
        "schema": SCHEMA,
        
        "writtenBy": format!("{}@{}", crate::brand::GUI_BIN_NAME, env!("CARGO_PKG_VERSION")),
        "nodeBinDir": bin_s,
        "npmPath": npm_s,
        "npmArgs": rt.npm_prefix,
        "node": { "path": node_s, "binDir": bin_s, "version": rt.version },
        "npm": { "path": npm_s, "args": rt.npm_prefix, "version": rt.npm_version },
                
        "nodePath": node_s,
        "nodeVersion": rt.version,
        "minNode": crate::node::min_node(),
        "source": "official-lts",
        "installedAt": crate::node::now_iso(),
        "updatedAt": crate::node::now_iso(),
    })
}

fn from_meta(v: &serde_json::Value) -> Option<NodeRuntime> {
    let node = v.get("nodePath").and_then(|x| x.as_str()).map(PathBuf::from)?;
    let node_bin_dir = v
        .get("nodeBinDir")
        .and_then(|x| x.as_str())
        .map(PathBuf::from)
        .or_else(|| node.parent().map(|p| p.to_path_buf()))?;
    let npm = v
        .get("npmPath")
        .and_then(|x| x.as_str())
        .map(PathBuf::from)
        .unwrap_or_else(|| node_bin_dir.join(crate::platform::current().npm_exe_name()));
    let npm_prefix: Vec<String> = v
        .get("npmArgs")
        .and_then(|x| x.as_array())
        .map(|a| a.iter().filter_map(|s| s.as_str().map(|s| s.to_string())).collect())
        .unwrap_or_default();
    let version = v.get("nodeVersion").and_then(|x| x.as_str()).unwrap_or("").to_string();
    let npm_version = v
        .get("npm")
        .and_then(|n| n.get("version"))
        .and_then(|x| x.as_str())
        .map(String::from);
    Some(NodeRuntime {
        node,
        node_bin_dir,
        npm,
        npm_prefix,
        version,
        npm_version,
    })
}

pub fn retarget_prefix(from: &Path, to: &Path) -> bool {
    let Some(cur) = read_node() else { return false; };
    let from_txt = from.to_string_lossy().to_string();
    let to_txt = to.to_string_lossy().to_string();
    let fix = |p: &Path| -> PathBuf {
        let s = p.to_string_lossy().to_string();
        if s.starts_with(&from_txt) {
            PathBuf::from(s.replacen(&from_txt, &to_txt, 1))
        } else {
            p.to_path_buf()
        }
    };
    let node = fix(&cur.node);
    let node_bin_dir = fix(&cur.node_bin_dir);
    let npm = fix(&cur.npm);
    let npm_prefix: Vec<String> = cur
        .npm_prefix
        .iter()
        .map(|s| {
            if s.starts_with(&from_txt) {
                s.replacen(&from_txt, &to_txt, 1)
            } else {
                s.clone()
            }
        })
        .collect();
    write(&NodeRuntime {
        node,
        node_bin_dir,
        npm,
        npm_prefix,
        version: cur.version,
        npm_version: cur.npm_version,
    });
    true
}

pub fn write(rt: &NodeRuntime) {
    let dir = crate::env::supervisor_dir();
    let _ = std::fs::create_dir_all(&dir);
    let p = path();
    let body = serde_json::to_string_pretty(&meta(rt)).unwrap_or_default();
    if let Err(e) = crate::atomic_write::write(&p, &(body + "\n")) {
        eprintln!("[runtime_contract] 落盘失败: {e}");
    }
}

/// 最近一次「环境为何不可用」的具名原因。
/// 只有字符串（Mutex<Option<String>>）而非结构体：唯一消费方是启动门与 UI 的报错文案，
/// 把它做成结构体等于为一个字段的传递引入新类型。上报方与读取方都在本 crate 内。
static LAST_PROBLEM: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);

fn set_problem(msg: String) {
    if let Ok(mut g) = LAST_PROBLEM.lock() {
        *g = Some(msg);
    }
}

fn clear_problem() {
    set_problem(String::new());
}

/// 最近一次环境不可用的原因（成功解析后为空）。
/// 供调用方如实报错：既用于启动门的 LaunchError，也用于 node_status 让 UI 显示原因
/// 而不是让用户面对一个无信息量的「启动失败」。
pub fn last_problem() -> Option<String> {
    LAST_PROBLEM
        .lock()
        .ok()
        .and_then(|g| g.clone())
        .filter(|s| !s.is_empty())
}
pub fn read_node() -> Option<NodeRuntime> {
    let s = std::fs::read_to_string(path()).ok()?;
    let v: serde_json::Value = serde_json::from_str(&s).ok()?;
    from_meta(&v)
}

/// 启动门：解析出**可用**的 Node/npm 契约。这是全产品唯一决定「用哪个 Node 拉起内核」的地方。
///
/// 架构约定（此前被违反，是真机「内核进不去」的根因）：
///   探测 → 判定 → 获取 三段必须在此汇聚。`nodeprobe` 只负责把版本号送到 UI，
///   `node::meets_minimum` 只负责把判定结果送到 UI，`domain::install::run_install`
///   只在用户主动跑安装向导时触发 —— 三者各自正确但互不相连，于是本函数长期只做
///   「文件在不在」的检查，把任何 PATH 上的 Node（包括 v10 这类远低于 min_node 的）
///   直接固化进 runtime.json，随后用它加载用了现代语法的 core.cjs，进程在解析阶段崩掉。
///
/// 现在的判定顺序：
///   1. runtime.json 记录且文件在位 → 仍须过 meets_minimum，达标才用（快路径不变）
///   2. 否则探测系统 Node → 达标则固化
///   3. 探测到但不达标，或根本探测不到 → 静默自动获取（复用 run_install 的既有闭环）
///   4. 获取失败 → 返回 None，并把**具体原因**写进 last_problem()，
///      供上层如实报错；绝不静默采纳一个不达标的版本。
pub fn ensure() -> Option<NodeRuntime> {
    // 1) 记录路径：文件在位**且版本达标**才直接采纳。
    if let Some(rt) = read_node() {
        if rt.node.is_file() && rt.npm.is_file() {
            if crate::node::meets_minimum(Some(rt.version.as_str())) {
                return Some(rt);
            }
            set_problem(format!(
                "已记录的 Node {} 低于最低要求 {}（记录路径 {}）",
                rt.version,
                crate::node::min_node(),
                rt.node.display()
            ));
        }
    }

    // 2) 探测系统 Node。探测本身不保证版本达标（nodeprobe::try_probe 只问「你几岁」）
    //    —— 门槛必须在这里补，否则这就是当初把 v10 当成「环境就绪」放行的那一行。
    if let Some((node, version)) = crate::env::probe_system_node().or_else(crate::node::probe_after) {
        if crate::node::meets_minimum(Some(version.as_str())) {
            if let Some(rt) = derive(&node, &version) {
                write(&rt);
                clear_problem();
                return Some(rt);
            }
        }
        set_problem(format!(
            "探测到的 Node {} 低于最低要求 {}",
            version,
            crate::node::min_node()
        ));
    } else {
        set_problem(format!(
            "未探测到可用的 Node/npm（最低要求 {}）",
            crate::node::min_node()
        ));
    }

    // 3) 不达标/探测不到：静默自动获取。复用 domain::install::run_install 的既有闭环
    //    （latest_lts -> download_verified -> install -> finalize_install），
    //    不新建第二套下载逻辑 —— 那正是「重复实现」的来源。
    crate::node::auto_install_quiet()
}

/// 开机时的环境补齐：达标但**已落后于最新 LTS** 时同样升级到最新 LTS。
///
/// 架构约定（此前缺失）：环境的**目标**是「当前最新 LTS」，而 `min_node` 只是
/// 「能不能跑内核」的下限兜底。此前 `ensure()` 只在不达标时才去获取，于是一台装过
/// v22 的机器会永远停在 v22：Node 出了新的 LTS 线（v24）也感知不到，
/// 而 `outdated()` 的结果只被送到 UI 做提示、从��参与决策 ——
/// 「检测到过期」与「去升级」是两件事，只做了前者。
///
/// 现在把检测接到决策上：达标但过期 -> 走同一条自动获取路径升到最新 LTS；
/// 无网络或获取失败 -> 静默保留现有达标版本继续用（降级可用，而不是变砖）。
pub fn ensure_with_upgrade() -> Option<NodeRuntime> {
    let cur = ensure();
    let rt = match cur.as_ref() {
        Some(r) => r.clone(),
        None => return cur, // ensure 内部已经尝试过自动获取且仍失败
    };
    // 已是最新（或查不到更新的）就不打扰：避免每次开机都去触网。
    let choice = match crate::node::latest_lts() {
        Ok(c) => c,
        Err(e) => {
            crate::update::log(&format!("[runtime] 查询最新 LTS 失败，沿用现有 Node {}: {}", rt.version, e));
            return cur;
        }
    };
    if !crate::node::outdated(Some(rt.version.as_str()), &choice.version) {
        return cur;
    }
    crate::update::log(&format!(
        "[runtime] 已装 Node {} 落后于最新 LTS {}，静默升级",
        rt.version, choice.version
    ));
    // 升级失败就保留现有达标版本：它仍能跑内核，比没有环境强。
    crate::node::auto_install_quiet().or(Some(rt))
}

pub fn env_path(node_bin_dir: &Path) -> String {
    let mut dirs: Vec<PathBuf> = vec![node_bin_dir.to_path_buf()];
    let h = crate::env::home();
    for d in [h.join(".npm-global").join("bin"), h.join(".local").join("bin")] {
        if !dirs.contains(&d) {
            dirs.push(d);
        }
    }
    if let Some(p) = std::env::var_os("PATH") {
        for d in std::env::split_paths(&p) {
            if !dirs.contains(&d) {
                dirs.push(d);
            }
        }
    }
    std::env::join_paths(&dirs)
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default()
}

#[cfg(test)]
mod toolchain_tests {
    use super::*;

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("dsh-npmprobe-{}-{}", tag, std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn spawnable_shim_name() -> String {
        let name = npm_shim_candidates(Path::new("."))
            .into_iter()
            .find(|p| crate::platform::current().is_directly_spawnable(p))
            .and_then(|p| p.file_name().map(|s| s.to_string_lossy().into_owned()))
            .expect("每个平台至少要有一个可直接 spawn 的垫片候选名");
        name
    }

    #[test]
    fn probe_npm_reports_missing_instead_of_fabricating() {
        let d = tmp("missing");
        let node = d.join("node");
        std::fs::write(&node, b"").unwrap();
        assert!(probe_npm(&node, &d).is_none(), "npm 缺失时必须返回 None，绝不伪造路径");
        let cli = npm_cli_js(&d);
        std::fs::create_dir_all(cli.parent().unwrap()).unwrap();
        std::fs::write(&cli, b"").unwrap();
        let got = probe_npm(&node, &d).expect("npm-cli.js 存在时应命中");
        assert_eq!(got.0, node);
        assert_eq!(got.1, vec![cli.display().to_string()]);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn probe_npm_prefers_executable_shim() {
        let d = tmp("shim");
        let node = d.join("node");
        let npm = d.join(spawnable_shim_name());
        std::fs::write(&node, b"").unwrap();
        std::fs::write(&npm, b"").unwrap();
        let got = probe_npm(&node, &d).expect("npm 垫片存在时应命中");
        assert_eq!(got.0, npm);
        assert!(got.1.is_empty());
        let _ = std::fs::remove_dir_all(&d);
    }

        
    #[test]
    fn probe_npm_result_is_always_directly_spawnable() {
        let layouts = ["shim", "shim+cli", "cli"];
        for layout in layouts {
            let d = tmp(layout);
            let node = d.join(crate::platform::current().node_exe_name());
            std::fs::write(&node, b"").unwrap();
            let shim = d.join(spawnable_shim_name());
            let cli = npm_cli_js(&d);
            std::fs::create_dir_all(cli.parent().unwrap()).unwrap();
            if layout != "cli" {
                std::fs::write(&shim, b"").unwrap();
            }
            if layout != "shim" {
                std::fs::write(&cli, b"").unwrap();
            }
            let (prog, args) = probe_npm(&node, &d).unwrap_or_else(|| panic!("{} 布局应可解析出 npm", layout));
            assert!(
                crate::platform::current().is_directly_spawnable(&prog),
                "{} 布局解析出的程序不可直接 spawn: {}",
                layout,
                prog.display()
            );
            assert_eq!(
                !args.is_empty(),
                prog == node,
                "{} 布局：args 与程序归属不一致（{:?} / {}）",
                layout,
                args,
                prog.display()
            );
            let _ = std::fs::remove_dir_all(&d);
        }
    }

    #[test]
    fn derive_requires_npm() {
        let d = tmp("derive");
        let node = d.join("node");
        std::fs::write(&node, b"").unwrap();
        assert!(derive(&node, "v22.12.0").is_none(), "无 npm → 环境不就绪");
        std::fs::write(d.join(spawnable_shim_name()), b"").unwrap();
        assert!(derive(&node, "v22.12.0").is_some(), "有 npm → 就绪");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn probe_npm_usable_rejects_non_executable() {
        let d = tmp("usable");
        let node = d.join("node");
        std::fs::write(&node, b"").unwrap();
        let npm = d.join(spawnable_shim_name());
        std::fs::write(&npm, b"").unwrap();
        let why = probe_npm_usable(&node, &d).err().expect("空/不可执行的 npm 不得判为可用（T-1b）");
        assert!(why.contains("npm"), "失败原因要说清缺的是 npm：{}", why);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn contract_roundtrip_carries_npm_version() {
        let d = tmp("roundtrip");
        let rt = NodeRuntime {
            node: d.join("node"),
            node_bin_dir: d.clone(),
            npm: d.join(crate::platform::current().npm_exe_name()),
            npm_prefix: vec!["/x/npm-cli.js".into()],
            version: "v22.12.0".into(),
            npm_version: Some("10.9.2".into()),
        };
        let back = from_meta(&meta(&rt)).expect("契约写读必须对称");
        assert_eq!(back.npm_version.as_deref(), Some("10.9.2"));
        assert_eq!(back.npm, rt.npm);
        assert_eq!(back.npm_prefix, rt.npm_prefix);
        assert_eq!(back.node_bin_dir, rt.node_bin_dir);
        assert_eq!(back.version, rt.version);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn derive_does_not_fabricate_npm_version() {
        let d = tmp("noexec");
        let node = d.join("node");
        std::fs::write(&node, b"").unwrap();
        let npm = d.join(spawnable_shim_name());
        std::fs::write(&npm, b"").unwrap();
        let rt = derive(&node, "v22.12.0").expect("node 与 npm 路径齐全 → derive 成功");
        assert!(rt.npm_version.is_none(), "未执行 npm 探测不得给出版本");
        assert!(meta(&rt)["npm"]["version"].is_null(), "落盘必须是 null 而非 \"\"");
        assert!(from_meta(&meta(&rt)).unwrap().npm_version.is_none());
        let _ = std::fs::remove_dir_all(&d);
    }
}
