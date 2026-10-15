//! Node.js 运行时的具体描述与适配（第一期唯一落地的运行时）。
//!
//! 只描述「Node 是什么」：版本索引在哪、产物怎么选、解包后 bin 在哪。
//! 引擎流程（下载/校验/切换/记录）在 runtime::engine 里，与本文件无关。

use super::{InstalledRuntime, RuntimeSpec, RuntimeVersion};
use crate::platform::external_path;
use std::path::{Path, PathBuf};

/// 上游版本索引路径。
///
/// 必须是**相对于镜像根**的路径，不能是完整 URL：mirror::probe_all 自己做
/// `format!("{}/{}", src, path)` 拼接。传完整 URL 会拼成
/// `https://mirror.nju.edu.cn/nodejs-release/https://nodejs.org/dist/index.json`
/// 这种无效地址 —— 真机症状是「全部镜像不可达」，与网络无关。
/// 镜像根见 mirror::NODE_PRESETS（如 .../nodejs-release、.../dist），故取 index.json。
pub const INDEX_PATH: &str = "index.json";

/// Node 专属安装根：**用户目录下专属区域**，不占用 npm 全局 prefix。
///
/// 旧实现装在 %APPDATA%/lobox/bin（= npm 全局 prefix），两个后果：
///   1. 我们的运行时和用户所有全局 npm 包混在同一目录；
///   2. 换装时会撞上正在运行的 node.exe（Windows 锁定 -> rename 失败）。
/// 换到专属目录后，npm prefix 保持用户原配置不变。
pub fn install_root() -> PathBuf {
    crate::runtime::root_for("node")
}

/// 供注册表登记的描述。
pub fn spec() -> Vec<RuntimeSpec> {
    vec![RuntimeSpec {
        id: "node",
        display_name: "Node.js",
        install_root: install_root(),
        index_path: INDEX_PATH,
    }]
}

/// 归档内解出可执行文件后的 bin 目录。
/// Node 的 zip/tar 解开后是 node-vXX/bin/node.exe 这类一层结构。
pub fn bin_dir_of(base: &Path, exe_name: &str) -> PathBuf {
    let direct = base.join(exe_name);
    if direct.is_file() {
        return base.to_path_buf();
    }
    // 解包多了一层 node-vXX.Y.Z-<platform>/：找第一个含目标 exe 的子目录。
    if let Ok(entries) = std::fs::read_dir(base) {
        let mut dirs: Vec<PathBuf> = entries
            .filter_map(|e| e.ok().map(|e| e.path()))
            .filter(|p| p.is_dir())
            .collect();
        dirs.sort();
        for d in dirs {
            if d.join(exe_name).is_file() {
                return d;
            }
        }
    }
    base.to_path_buf()
}


/// 选择策略：从上游索引挑「最新 LTS」。
/// 非 LTS（奇数线）不取 —— 生产环境不装非稳定版。
/// 从上游索引 JSON 中挑最新 LTS：只收 lts 非 null，取 semver 最大。
pub fn pick_latest_lts(raw: &str) -> Option<(String, String)> {
    let idx: serde_json::Value = serde_json::from_str(raw).ok()?;
    let arr = idx.as_array()?;
    let mut best: Option<(String, String)> = None;
    for item in arr {
        let lts = item.get("lts");
        let is_lts = match lts {
            Some(v) if !v.is_null() && v.as_str() != Some("false") => true,
            _ => false,
        };
        if !is_lts {
            continue;
        }
        let ver = match item.get("version").and_then(|v| v.as_str()) {
            Some(v) if !v.is_empty() => v,
            _ => continue,
        };
        let files: Vec<String> = item
            .get("files")
            .and_then(|a| a.as_array())
            .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
            .unwrap_or_default();
        // 产物判定必须走平台层：NodeArtifact 同时给出 tag（如 win-x64-zip）与
        // 完整文件名（node-v24.22.0-win-x64.zip）。索引的 files 数组里放的是
        // **tag**，不是文件名 —— 此前本文件自己拼完整文件名去比对，永远匹配不上，
        // 真机症状是「版本索引中没有可用的 LTS 产物」。
        let art = match crate::platform::current().node_artifact(ver.trim_start_matches('v')) {
            Some(a) => a,
            None => continue,
        };
        if !files.iter().any(|f| f == &art.tag || f == &art.file) {
            continue;
        }
        let file = art.file;
        let newer = match best.as_ref() {
            None => true,
            Some((bv, _)) => crate::core::semver_cmp(ver, bv) > 0,
        };
        if newer {
            best = Some((ver.to_string(), file));
        }
    }
    best
}

/// 端到端：解析最新 LTS -> 下载校验 -> 解包 staging -> 切换到专属目录 -> 接入用户 PATH。
///
/// 与旧实现的差别（旧实现散落在 node.rs / platform/*::install_node / domain::install）：
///   - 落点从 npm 全局 prefix 改为**专属目录**，不再与用户全局 npm 包混放；
///   - 换装走 engine::swap，备份失败时**不删除旧装**并给出可执行的处置说明；
///   - 落定后把 bin 目录接入**用户级 PATH**，使新终端/IDE 直接可用；
///   - 产出 InstalledRuntime 供契约落盘，不再只改子进程 PATH。
/// 安装过程的可选观测点。
///
/// 底座被两条路径共用：开机静默获取（无 UI）与引导页安装（有进度条）。
/// 因此流程本身不直接 emit 事件，而是把阶段回调交给调用方 ——
/// 这样「同一套安装逻辑」不会分裂成两份实现。
#[derive(Clone, Default)]
pub struct Progress {
    /// (阶段描述, 已下载字节, 总量)
    pub on_stage: Option<std::sync::Arc<dyn Fn(&str, u64, Option<u64>) + Send + Sync>>,
}

impl Progress {
    pub fn stage(&self, msg: &str, done: u64, total: Option<u64>) {
        if let Some(f) = self.on_stage.as_ref() {
            f(msg, done, total);
        } else {
            crate::update::log(msg);
        }
    }
}

/// 选版结果：给引导页展示用（镜像来源、延迟、选定版本）。
#[derive(Debug, Clone)]
pub struct Selection {
    pub version: String,
    pub file: String,
    pub source: String,
    pub latency_ms: u128,
}

/// 解析最新 LTS。公开出来是为了让引导页能先展示「将安装哪个版本」，
/// 而不是等到下载完才知道 —— 这也避免与 install_latest 内部重复一次选版。
pub fn select_latest() -> Result<Selection, String> {
    let m = crate::mirror::load();
    let probes = crate::mirror::probe_all(&m.node, super::node::INDEX_PATH);
    let hit = probes
        .into_iter()
        .find(|p| p.ok)
        .ok_or_else(|| "无法获取 Node 版本索引（全部镜像不可达）".to_string())?;
    // body 是 Option<String>：探到镜像可达不等于拿到了内容，空的要说清是哪一步空的。
    let body = hit
        .body
        .ok_or_else(|| format!("镜像 {} 可达但未返回索引内容", hit.source))?;
    let (version, file) = pick_latest_lts(&body)
        .ok_or_else(|| "版本索引中没有可用的 LTS 产物".to_string())?;
    Ok(Selection {
        version,
        file,
        source: hit.source,
        latency_ms: hit.latency_ms,
    })
}
/// 端到端安装：解析最新 LTS -> 下载校验 -> 解包 staging -> 切换到专属目录 -> 接入用户 PATH。
///
/// 与旧实现的差别（旧实现散落在 domain/install.rs::run_install 与 platform/*::install_node）：
///   - 落点从 npm 全局 prefix 改为 %LOCALAPPDATA%/lobox/runtime/node（专属目录），
///     不再与用户全局 npm 包混放，也不再撞上正在运行的 node.exe；
///   - 换装走 engine::swap，备份失败时不删除旧装并给出可执行的处置说明；
///   - 落定后把 bin 目录接入用户级 PATH，使新终端/IDE 直接可用；
///   - 进度经 Progress 回调交给调用方，开机静默与引导页安装共用同一份流程。
pub fn install_latest(progress: &Progress) -> Result<InstalledRuntime, String> {
    let sel = select_latest()?;
    progress.stage(
        &format!("选用镜像 {}（{}ms），官方最新 LTS {}", sel.source, sel.latency_ms, sel.version),
        0,
        None,
    );
    let dl_dir = crate::env::supervisor_dir().join("dl");
    let cb = progress.clone();
    let local = crate::node::download_verified(
        &sel.version,
        &sel.file,
        &dl_dir,
        Some(sel.source.as_str()),
        &move |done, total| {
            cb.stage("正在下载 Node 官方归档…", done, total);
        },
    )?;
    progress.stage("SHA256 校验通过，准备安装…", 0, None);
    let root = external_path(&install_root());
    let staging = root.with_extension("staging");
    let _ = std::fs::remove_dir_all(&staging);
    std::fs::create_dir_all(&staging).map_err(|e| e.to_string())?;
    progress.stage("正在解包…", 0, None);
    crate::platform::current().extract_archive(&local, &staging)?;
    let exe = crate::platform::current().node_exe_name();
    let staged_bin = bin_dir_of(&staging, exe);
    // 切换：备份失败即中止且不删旧装（那可能是系统正在用的那一份）。
    let backup = root.with_extension("prev");
    super::engine::swap(&staged_bin, &root, &backup)?;
    let bin_dir = bin_dir_of(&root, exe);
    // 接入用户 PATH：这是「全局可用」与「私有捆绑」的分界。
    //
    // 但它是**附加价值，不是安装成败的判据**：此刻 Node 已经解包、换装、落定完毕，
    // 装的本体是好的。PATH 注册失败只意味着「新开的终端还看不到它」，
    // 不该反过来报「Node 未能就绪」把一次成功的安装说成失败 ——
    // 真机就因此卡在这一步，前面的选版/下载/解包/换装全部白做。
    // 降级为告警 + 照常返回，用户可自行把该目录加入 PATH。
    // on_path 反映的是「本次是否发生变更」，不是「是否最终在 PATH 里」——
    let path_changed = match super::ensure_on_user_path(&bin_dir) {
        Ok(changed) => changed,
        Err(e) => {
            crate::update::log(&format!(
                "[runtime] Node 已装好，但写入用户 PATH 失败（{}）。",
                e
            ));
            progress.stage(
                &format!(
                    "Node 已就绪；未能自动加入用户 PATH（{}），可手动添加 {}",
                    e,
                    bin_dir.display()
                ),
                0,
                None,
            );
            false
        }
    };
    progress.stage("正在校验 npm…", 0, None);
    crate::update::log(&format!(
        "[runtime] node {} 已落定 {}（用户 PATH {}）",
        sel.version,
        root.display(),
        if path_changed { "已接入，重启终端后生效" } else { "已在" }
    ));
    Ok(InstalledRuntime {
        spec_id: "node".to_string(),
        version: sel.version.clone(),
        bin_dir: bin_dir.clone(),
        executable: bin_dir.join(exe),
        on_path: true,
        updated_at: crate::node::now_iso(),
    })
}

/// 判断已装版本是否**不在当前 LTS 线上**。
///
/// 与 outdated（纯版本号比较）互补：真机装过 v26 —— 那是 Node 的非 LTS 偶数线，
/// 版本号比任何 LTS 都「新」，于是 outdated(v26, v24.21.0) 为 false，
/// 结果永远停在 v26、再也升不到 LTS。
/// 生产环境要装的是 LTS 线，所以「装了非 LTS」本身就是需要纠正的状态，
/// 与其版本号新旧无关。
pub fn off_lts_line(installed: &str, latest_lts: &str) -> bool {
    let i = installed.trim().trim_start_matches('v');
    let l = latest_lts.trim().trim_start_matches('v');
    let major = |v: &str| v.split('.').next().unwrap_or("").parse::<i64>().unwrap_or(-1);
    if major(i) < 0 || major(l) < 0 {
        return false;
    }
    major(i) != major(l)
}