//! 内核位置契约（core.json）- 壳写、双方读（schema 1），已装内核位置的单一事实源。
//! 壳用 npm 把内核装进「npm 全局 prefix」，而 locate_core 只能按 PATH + 少数固定目录猜；
//! nvm/volta/fnm 或自定义 prefix 下内核落在别处，「装上了却永远拉不起来」。壳在安装/升级成功后写确切 bin/prefix/version/source，
//! locate_core 先读契约、读不到才退回启发式（前向自愈）。不变量：只有壳写（内核只读）；原子写（tmp + rename）；版本须与写入时线上最新一致。

use std::path::PathBuf;

/// 契约 schema 版本（与壳测试 K-1 锁定）。
pub const SCHEMA: u32 = 1;

/// 已安装内核的位置事实。
#[derive(Clone, Debug)]
pub struct InstalledCore {
    /// 内核可执行（npm 垫片或包内真实脚本，壳可直接执行/经 node 执行）。
    pub bin: PathBuf,
    /// npm 全局前缀（反推；可能为 None）。
    pub prefix: Option<PathBuf>,
    /// 安装后的版本（应等于线上最新）。
    pub version: String,
    /// 命中的镜像源 origin。
    pub source: String,
}

/// 契约文件路径（`<产品状态根>/supervisor/core.json`，与内核状态同域）。
pub fn path() -> PathBuf {
    crate::env::supervisor_dir().join("core.json")
}

/// 原子写契约（tmp + rename）。失败不 panic（调用方据返回码决定）。
pub fn write(c: &InstalledCore) {
    let dir = crate::env::supervisor_dir();
    let _ = std::fs::create_dir_all(&dir);
    let meta = serde_json::json!({
        "schema": SCHEMA,
        "writtenBy": format!("dsh-supervisor-gui@{}", env!("CARGO_PKG_VERSION")),
        "bin": c.bin.display().to_string(),
        "prefix": c.prefix.as_ref().map(|p| p.display().to_string()),
        "version": c.version,
        "source": c.source,
        "installedAt": crate::node::now_iso(),
    });
    let p = path();
    let body = serde_json::to_string_pretty(&meta).unwrap_or_default();
    let tmp = p.with_extension("json.tmp");
    if std::fs::write(&tmp, body + "\n").is_ok() {
        let _ = std::fs::rename(&tmp, &p);
    } else {
        let _ = std::fs::remove_file(&tmp);
    }
}

/// 读回契约；缺失/损坏/schema 不符返回 None（调用方退回启发式，绝不猜）。
pub fn read() -> Option<InstalledCore> {
    let s = std::fs::read_to_string(path()).ok()?;
    let v: serde_json::Value = serde_json::from_str(&s).ok()?;
    if v.get("schema").and_then(|x| x.as_u64()) != Some(SCHEMA as u64) {
        return None;
    }
    let bin = PathBuf::from(v.get("bin").and_then(|x| x.as_str())?);
    let version = v.get("version").and_then(|x| x.as_str())?.to_string();
    let prefix = v.get("prefix").and_then(|x| x.as_str()).map(PathBuf::from);
    let source = v.get("source").and_then(|x| x.as_str()).unwrap_or("").to_string();
    Some(InstalledCore { bin, prefix, version, source })
}
