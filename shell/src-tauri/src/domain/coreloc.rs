use tauri::Manager;

use std::path::PathBuf;

/// J-2-a（architect §33）：读内核事件账本里**最近一次** `api_port_skew` 的 `to` 端口。
///
/// 为什么壳要读内核的账本：内核 `api-rebind.js:75` 在端口被占时顺延并发
/// `api_port_skew {from, to, reason}`，**但不写 `ports.json`** ⇒ 而壳的
/// `current_api_port()` 只读 `ports.json` ⇒ 回落配置端口 ⇒ 探不到已顺延的内核
/// ⇒ healer 重拉 ⇒ 多份内核互相不可见。
///
/// ⇒ 壳读内核已发现的结论（**不自己再探一次端口占用**）⇒ 那正是「发现只做一次」。
///
/// ⚠️ **只读账本尾部**（`TAIL_BYTES`）：本函数在 `await_daemon` 的就绪轮询循环里
///    被反复调（间隔 500ms，预算 60s ⇒ 最多约 120 次），而账本实测 1.47MB 且在增长
///    ⇒ 每轮全文件读 + `lines().rev()` 全量反转 ⇒ 单次启动要读 176MB。
///    而 `api_port_skew` 若发生，必在**最近**（顺延就发生在内核启动那一刻）⇒
///    故只读尾部即可，且那让成本恒定。
pub fn latest_api_port_skew() -> Option<u16> {
    let tail = read_ledger_tail()?;
    for line in tail.lines().rev() {
        if !line.contains("api_port_skew") {
            continue;
        }
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else { continue };
        let to = v.get("data").and_then(|d| d.get("to")).and_then(|t| t.as_u64())?;
        if to > 0 && to <= u16::MAX as u64 {
            return Some(to as u16);
        }
    }
    None
}

/// J-2-d（architect §27.7 Q-4 + §29.4 + §33）：顺延次数必须**可见**，不得归 0。
///
/// 背景：内核 `api-rebind.js:69` 的 `const maxSkew = 50` 是它自己的顺延预算 ⇒
/// 而它是**内核侧的局部常量**，壳侧看不到 ⇒ 于是「内核已经顺延到第 N 次」对壳
/// 不可见 ⇒ 而 architect 裁的是**「必须可见」而不是「归 0」**：归 0 会把「顺延」
/// 当成「正常」，而那与「只有一个内核」矛盾。
///
/// 形态：壳**不存一份 50**（那会造第二份事实源，改一侧漏一侧）⇒ 而是报
/// **尾部窗口内已顺延几次** ⇒ 那正是「内核已经顺延了几次」的直接度量。
///
/// §7.146（Lead 立）：报「已经发生几次」比报「它的预算是几」更强——前者是症状
/// （直接说明多过），后者是配置（只说明能多多少），而报配置常会诱使人存第二份。
pub fn api_port_skew_count() -> Option<u32> {
    let tail = read_ledger_tail()?;
    let n = tail.lines().filter(|l| l.contains("api_port_skew")).count();
    if n == 0 { None } else { Some(n as u32) }
}

/// 尾部窗口大小：256KB ≈ 上千条 JSONL 事件。恒定成本，且足以覆盖
/// 「顺延就发生在内核启动那一刻」这个时间相邻性。
const TAIL_BYTES: u64 = 256 * 1024;

/// 读内核事件账本的尾部窗口（**不读全文件**）。
///
/// 读失败 ⇒ `None`（文件不存在 / 不可读）⇒ 调用方回落原路径，不影响原有行为。
fn read_ledger_tail() -> Option<String> {
    use std::io::{Read, Seek, SeekFrom};
    let path = crate::env::supervisor_dir().join("events").join("guard.events.log");
    let mut f = std::fs::File::open(&path).ok()?;
    let len = f.seek(SeekFrom::End(0)).ok()?;
    let start = len.saturating_sub(TAIL_BYTES);
    f.seek(SeekFrom::Start(start)).ok()?;
    let mut buf = Vec::new();
    f.take(TAIL_BYTES).read_to_end(&mut buf).ok()?;
    Some(String::from_utf8_lossy(&buf).into_owned())
}

pub(crate) fn core_exe_names() -> &'static [&'static str] {
    crate::platform::current().core_exe_names()
}

pub fn normalize_guard(bin: PathBuf, pkg: Option<&str>) -> PathBuf {
    let bare = crate::platform::external_path(&bin);
    let ext = bare.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase());
    if matches!(ext.as_deref(), Some("cmd") | Some("bat") | Some("ps1")) {
        if let (Some(dir), Some(pkg), Some(stem)) = (bare.parent(), pkg, bare.file_stem()) {
            let internal = dir.join("node_modules").join(pkg).join("bin").join(stem);
            if internal.is_file() {
                return crate::platform::external_path(&internal);
            }
        }
    }
    bare
}

pub(crate) fn locate_core_candidates(resource_dir: Option<PathBuf>) -> Vec<PathBuf> {
    let home = crate::env::home();
    let mut out: Vec<PathBuf> = Vec::new();
    let pkg_for_add = crate::core::package_name().ok();
    let add = |p: PathBuf, out: &mut Vec<PathBuf>| {
        if let Some(dir) = p.parent() {
            if !crate::env::is_local_fixed_dir(dir) { return; }
        }
        if !p.is_file() { return; }
        let real = normalize_guard(
            std::fs::canonicalize(&p).unwrap_or(p),
            pkg_for_add.as_deref(),
        );
        if !out.contains(&real) { out.push(real); }
    };
    
    let names_owned: Vec<&str> = crate::domain::coreloc::core_exe_names().to_vec();
    if let Some(c) = crate::core_contract::read() {
        add(c.bin.clone(), &mut out);
    }
    if let Some(rt) = crate::runtime_contract::read_node() {
        for name in &names_owned {
            add(rt.node_bin_dir.join(name), &mut out);
        }
    }
    for name in crate::domain::coreloc::core_exe_names().iter().copied() {
        if let Some(p) = crate::env::find_in_path(name) { add(p, &mut out); }
    }
    {
        let names: Vec<&str> = crate::domain::coreloc::core_exe_names().to_vec();
        let pkg = crate::core::package_name().ok();
        for p in crate::platform::current().core_extra_candidates(&names, pkg.as_deref()) {
            add(p, &mut out);
        }
    }
    for name in crate::domain::coreloc::core_exe_names().iter().copied() {
        add(home.join(".npm-global").join("bin").join(name), &mut out);
        add(home.join(".local").join("bin").join(name), &mut out);
    }
    if let Some(res) = resource_dir {
        for name in crate::domain::coreloc::core_exe_names().iter().copied() { add(res.join("bin").join(name), &mut out); }
    }
    out
}

pub(crate) fn locate_core_at_version(
    app: &tauri::AppHandle,
    version: &str,
    prefix: Option<&std::path::Path>,
) -> Option<PathBuf> {
    let mut cands = locate_core_candidates(app.path().resource_dir().ok());
    if let Some(p) = prefix {
        let names: Vec<&str> = core_exe_names().to_vec();
        let pkg = crate::core::package_name().ok();
        for c in crate::platform::current().core_bin_candidates_in_prefix(p, &names, pkg.as_deref()) {
            cands.push(c);
        }
    }
    cands
        .into_iter()
        .find(|c| crate::core::installed_version(c).as_deref() == Some(version))
}

pub(crate) fn locate_core(app: &tauri::AppHandle) -> Option<PathBuf> {
    locate_core_with_version(app).map(|(p, _)| p)
}

/// 多候选仲裁的**唯一**实现：版本降序，版本相同取路径字典序升序（首）。
/// 此前另有 pick_highest（max_by，平局取 last）与此处并列存在，两套判据结论相反，
/// 同版本时谁胜出取决于候选顺序（即 PATH 顺序）。已删除前者。
pub(crate) fn locate_core_with_version(app: &tauri::AppHandle) -> Option<(PathBuf, Option<String>)> {
    let cands = crate::domain::coreloc::locate_core_candidates(app.path().resource_dir().ok());
    // pick_best 的第二元素已是 Option<String>（读不出版本即为 None），
    // 此处直接透传；此前多包一层 Some(...) 会把 None 变成 Some(None) 并触发类型不匹配。
    pick_best(cands)
}

/// 与 locate_core_with_version 同一判据，但不依赖 AppHandle（CLI 与 --run-guard 走这条）。
pub fn pick_best(cands: Vec<PathBuf>) -> Option<(PathBuf, Option<String>)> {
    if cands.is_empty() { return None; }
    let mut ranked: Vec<(PathBuf, Option<String>)> = cands
        .into_iter()
        .map(|c| {
            let v = crate::core::installed_version(&c);
            (c, v)
        })
        .collect();
    // 读不出版本的候选排在有版本之后（不是并列第一）。
    ranked.sort_by(|a, b| {
        let key = |x: &(PathBuf, Option<String>)| match &x.1 {
            Some(v) => (0u8, v.clone()),
            None => (1u8, String::new()),
        };
        let (ak, av) = key(a);
        let (bk, bv) = key(b);
        crate::core::semver_cmp(&av, &bv).cmp(&0).then_with(|| ak.cmp(&bk)).then_with(|| a.0.cmp(&b.0))
    });
    Some(ranked.into_iter().next()?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::{Path, PathBuf};

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("dsh-guardres-{}-{}", tag, std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn fake_pkg(dir: &Path, version: &str) {
        let bin = dir.join("bin").join("lobox");
        std::fs::create_dir_all(bin.parent().unwrap()).unwrap();
        std::fs::write(&bin, b"// fake guard\n").unwrap();
        std::fs::write(dir.join("package.json"), format!("{{\"version\":\"{}\"}}", version)).unwrap();
    }

    #[test]
    fn normalize_guard_maps_cmd_shim_to_internal_js() {
        let root = tmp("norm");
        let prefix = root.join("npm");
        std::fs::create_dir_all(&prefix).unwrap();
        let shim = prefix.join("lobox.cmd");
        std::fs::write(&shim, b"@echo off\n").unwrap();
        let internal = prefix.join("node_modules").join("@lob-ox").join("core-x").join("bin").join("lobox");
        std::fs::create_dir_all(internal.parent().unwrap()).unwrap();
        std::fs::write(&internal, b"// js\n").unwrap();
        let got = normalize_guard(shim.clone(), Some("@lob-ox/core-x"));
        assert_eq!(got, internal, "1.1.5 真机缺陷：.cmd 垫片被直接交给 node（EISDIR）");
        let js = prefix.join("bin").join("lobox");
        std::fs::create_dir_all(js.parent().unwrap()).unwrap();
        std::fs::write(&js, b"// js\n").unwrap();
        assert_eq!(normalize_guard(js.clone(), None), js);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn pick_best_takes_newest_version_and_breaks_ties_by_path() {
        let root = tmp("pick");
        let a = root.join("pkgA");
        let b = root.join("pkgB");
        fake_pkg(&a, "0.1.0");
        fake_pkg(&b, "0.2.0");
        let abin = a.join("bin").join("lobox");
        let bbin = b.join("bin").join("lobox");
        assert_eq!(
            pick_best(vec![abin, bbin.clone()]).map(|(p, _)| p),
            Some(bbin.clone()),
            "应按版本最高仲裁（内核只有最新版本）"
        );
        // 同版本：路径字典序升序取首，两种输入顺序结论必须相同（此前 max_by 取 last，取决于 PATH 顺序）。
        let c = root.join("pkgC");
        fake_pkg(&c, "0.2.0");
        let cbin = c.join("bin").join("lobox");
        let fwd = pick_best(vec![bbin.clone(), cbin.clone()]).map(|(p, _)| p);
        let rev = pick_best(vec![cbin.clone(), bbin.clone()]).map(|(p, _)| p);
        assert_eq!(fwd, rev, "同版本时结论不得取决于输入顺序");
        assert_eq!(fwd, Some(bbin), "同版本应取路径字典序最小");
        let _ = std::fs::remove_dir_all(&root);
    }
}
