//! 内核（`dsh-supervisor`）的定位：候选枚举 + 版本仲裁。内核是 npm 全局包，落点随安装方式而异，
//! 故枚举全部候选再按版本取最高；只认一个路径会在「装了却找不到」或「装了新版却用旧版」时出错。
//! 平台差异已下沉到 platform 层，本模块平台无关（门禁 G1）。is_file/canonicalize 在断开的映射盘或 UNC 上
//! 会触网，故先问 `platform::is_local_fixed_dir`（GetDriveTypeW 不触网）再访问文件系统。
use tauri::Manager;

use std::path::PathBuf;

/// 内核可执行候选名 —— 下沉到 trait（P2/G1：原为 `cfg!()` 宏）。
pub(crate) fn core_exe_names() -> &'static [&'static str] {
    crate::platform::current().core_exe_names()
}

/// 把 npm 垫片规范化为可被 node 执行的 JS 入口。Windows 的 npm 全局 bin 是 `<prefix>\<name>.cmd`
/// 批处理垫片，`node <垫片>` 会当 JS 解析而必然失败；真实入口在
/// `<prefix>\node_modules\<pkg>\bin\<name>`，找不到包内入口时原样返回（平台层会退回 `cmd /C`）。
/// 返回值总是外部工具可用的规范路径：归一在 `platform::external_path` 一处完成，调用方不得再各自剥前缀。
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

/// 在候选集中按**版本最高**仲裁（读 package.json，无进程开销）。
///
/// 单一实现：`resolve_local`（--run-guard 运行时检测）与 `locate_core_with_version` 同源。
pub fn pick_highest(cands: Vec<PathBuf>) -> Option<PathBuf> {
    cands
        .into_iter()
        .filter_map(|c| crate::core::installed_version(&c).map(|v| (c, v)))
        .max_by(|a, b| crate::core::semver_cmp(&a.1, &b.1).cmp(&0))
        .map(|(c, _)| c)
}

/// 收集全部内核候选（去重 + 解析符号链接）供版本仲裁：PATH（Windows 走 PATHEXT）、
/// %APPDATA%\npm 与包内真实脚本、/opt/homebrew/bin 与 /usr/local/bin、
/// ~/.npm-global/bin 与 ~/.local/bin、资源目录内嵌兜底。
/// `resource_dir` 为 None 时跳过内嵌兜底 —— CLI 自检（无 AppHandle）走这条。
pub(crate) fn locate_core_candidates(resource_dir: Option<PathBuf>) -> Vec<PathBuf> {
    let home = crate::env::home();
    let mut out: Vec<PathBuf> = Vec::new();
  // 与 env.rs 的 PATH 探测同一类防护：
  //  is_file() / canonicalize() 底层会触网 —— 在断开的映射盘或 UNC 路径上
  //  可能阻塞数十秒，而本函数在**内核定位的关键路径**上（引导页每一步都要用）。
  //  故先做「本地固定盘」判定（GetDriveTypeW 自身不触网），再访问文件系统。
    let pkg_for_add = crate::core::package_name().ok();
    let add = |p: PathBuf, out: &mut Vec<PathBuf>| {
        if let Some(dir) = p.parent() {
            if !crate::env::is_local_fixed_dir(dir) { return; }
        }
        if !p.is_file() { return; }
  // 1) 解析 ~/.local/bin 软链到包内真实路径；
  // 2)3) 都由 normalize_guard 完成：剥掉 Windows verbatim/device 前缀（外部工具不接受，
  //  规则只在 platform::external_path 一处），并把 .cmd 垫片换成包内 JS 入口。
        let real = normalize_guard(
            std::fs::canonicalize(&p).unwrap_or(p),
            pkg_for_add.as_deref(),
        );
        if !out.contains(&real) { out.push(real); }
    };
  // 1) 位置契约优先（core.json.bin）—— 安装成功后壳写入的**确切位置**。
  //  为什么必须最先：npm 全局 prefix 可能是 nvm/volta/fnm 的 node 目录或任何自定义目录，
  //  PATH 与下面两个硬编码目录都不含它；契约是唯一可靠的事实源。
    let names_owned: Vec<&str> = crate::domain::coreloc::core_exe_names().to_vec();
    if let Some(c) = crate::core_contract::read() {
        add(c.bin.clone(), &mut out);
    }
  // 2) 运行期契约派生：内核由 npm 装到 node 所在 prefix，其 bin 就在 nodeBinDir。
    if let Some(rt) = crate::runtime_contract::read_node() {
        for name in &names_owned {
            add(rt.node_bin_dir.join(name), &mut out);
        }
    }
  // 3) 启发式：壳进程 PATH。
    for name in crate::domain::coreloc::core_exe_names().iter().copied() {
        if let Some(p) = crate::env::find_in_path(name) { add(p, &mut out); }
    }
  // 平台额外候选（Windows 的 %APPDATA%\npm 与包内真实脚本；macOS 的 Homebrew 落点）
  // —— 已下沉到 platform 层，本文件不再出现平台分支。
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

/// 在候选集（含指定 prefix 的平台候选）中找**恰好等于 `version`** 的内核。
///
/// 用途：P2「安装成功后回读确切位置并记录 core.json」。找不到 -> None：
///  调用方必须**如实报**「已安装但定位不到目标版本（安装前缀不一致）」，绝不假装成功。
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

/// 定位已安装内核：多候选**按版本最高**仲裁（K5 修复）——旧内核不得遮蔽新内核。
pub(crate) fn locate_core(app: &tauri::AppHandle) -> Option<PathBuf> {
    locate_core_with_version(app).map(|(p, _)| p)
}

/// 定位内核并**一并返回其版本**（避免调用方再执行一次二进制取版本）。
///
/// 仲裁规则（K5）：多候选中**按版本最高**选取 —— 旧内核不得遮蔽新内核；探测失败的候选不参与
/// 仲裁，整批都探不到时版本返回 `None`，而非会一路显示到面板的假版本 0.0.0。
pub(crate) fn locate_core_with_version(app: &tauri::AppHandle) -> Option<(PathBuf, Option<String>)> {
    let cands = crate::domain::coreloc::locate_core_candidates(app.path().resource_dir().ok());
    if cands.is_empty() { return None; }
    let mut best: Option<(PathBuf, String)> = None;
    for c in &cands {
        let v = match crate::core::installed_version(c) {
            Some(v) => v,
            None => continue,
        };
        let better = best.as_ref().map(|(_, bv)| crate::core::semver_cmp(&v, bv) > 0).unwrap_or(true);
        if better { best = Some((c.clone(), v)); }
    }
    Some(match best {
        Some((p, v)) => (p, Some(v)),
        None => (cands.into_iter().next()?, None),
    })
}

#[cfg(test)]
mod tests {
  //! 行为门禁：直接驱动路径规范化与版本仲裁，
  //! 而不是 `str::contains` —— 真机 1.1.4/1.1.5 的失效正是「静态断言全部通过、运行时把
  //! `.cmd` 交给 node」。
    use super::*;
    use std::path::{Path, PathBuf};

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("dsh-guardres-{}-{}", tag, std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn fake_pkg(dir: &Path, version: &str) {
        let bin = dir.join("bin").join("dsh-supervisor");
        std::fs::create_dir_all(bin.parent().unwrap()).unwrap();
        std::fs::write(&bin, b"// fake guard\n").unwrap();
        std::fs::write(dir.join("package.json"), format!("{{\"version\":\"{}\"}}", version)).unwrap();
    }

    #[test]
    fn normalize_guard_maps_cmd_shim_to_internal_js() {
        let root = tmp("norm");
        let prefix = root.join("npm");
        std::fs::create_dir_all(&prefix).unwrap();
        let shim = prefix.join("dsh-supervisor.cmd");
        std::fs::write(&shim, b"@echo off\n").unwrap();
        let internal = prefix.join("node_modules").join("@dsh-sup").join("dsh-core-x").join("bin").join("dsh-supervisor");
        std::fs::create_dir_all(internal.parent().unwrap()).unwrap();
        std::fs::write(&internal, b"// js\n").unwrap();
        let got = normalize_guard(shim.clone(), Some("@dsh-sup/dsh-core-x"));
        assert_eq!(got, internal, "1.1.5 真机缺陷：.cmd 垫片被直接交给 node（EISDIR）");
  // 已是 JS 入口时原样返回。
        let js = prefix.join("bin").join("dsh-supervisor");
        std::fs::create_dir_all(js.parent().unwrap()).unwrap();
        std::fs::write(&js, b"// js\n").unwrap();
        assert_eq!(normalize_guard(js.clone(), None), js);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn pick_highest_takes_newest_version() {
        let root = tmp("pick");
        let a = root.join("pkgA");
        let b = root.join("pkgB");
        fake_pkg(&a, "0.1.0");
        fake_pkg(&b, "0.2.0");
  // pick_highest 的入参是**候选 bin 路径**（与 locate_core_candidates 同形），不是包目录。
        let abin = a.join("bin").join("dsh-supervisor");
        let bbin = b.join("bin").join("dsh-supervisor");
        assert_eq!(pick_highest(vec![abin, bbin.clone()]), Some(bbin), "应按版本最高仲裁（内核只有最新版本）");
        let _ = std::fs::remove_dir_all(&root);
    }
}
