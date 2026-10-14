use tauri::Manager;

use std::path::PathBuf;

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
    pick_best(cands).map(|(p, v)| (p, Some(v)))
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
