//! 内核位置契约（core.json，schema 1）：壳写、双方读，已装内核位置的单一事实源。locate_core 只能按 PATH + 少数固定目录猜（nvm/volta/fnm 或自定义 prefix 下会猜错），故壳安装/升级成功后写确切 bin/prefix/version/source，locate_core 先读契约、读不到才退回启发式。不变量：只有壳写（内核只读）；原子写；版本须与写入时线上最新一致。

use std::path::PathBuf;

pub const SCHEMA: u32 = 1;

#[derive(Clone, Debug)]
pub struct InstalledCore {
    pub bin: PathBuf,
    pub prefix: Option<PathBuf>,
    pub version: String,
    pub source: String,
}

pub fn path() -> PathBuf {
    crate::env::supervisor_dir().join("core.json")
}

pub fn write(c: &InstalledCore) {
    let dir = crate::env::supervisor_dir();
    let _ = std::fs::create_dir_all(&dir);
    let meta = serde_json::json!({
        "schema": SCHEMA,
        // 署名 = 单源 `GUI_BIN_NAME` + 壳版本；壳四处契约必须同形（J-10 对账）。
        "writtenBy": format!("{}@{}", crate::brand::GUI_BIN_NAME, env!("CARGO_PKG_VERSION")),
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

/// 私有 Node 迁到全局后，**位置契约必须跟着改**：core.json 若仍指向已搬走的私有路径，
/// 守卫就找不到内核入口（这正是"迁移后起不来"的形态）。只重写落在旧前缀下的条目。
pub fn retarget_prefix(from: &std::path::Path, to: &std::path::Path) -> bool {
    let Some(cur) = read() else { return false; };
    let cur_txt = cur.bin.to_string_lossy().to_string();
    let from_txt = from.to_string_lossy().to_string();
    if !cur_txt.starts_with(&from_txt) {
        return false;
    }
    let new_txt = cur_txt.replacen(&from_txt, &to.to_string_lossy().to_string(), 1);
    let prefix_txt = cur
        .prefix
        .as_ref()
        .map(|p| p.to_string_lossy().to_string())
        .map(|s| {
            if s.starts_with(&from_txt) {
                s.replacen(&from_txt, &to.to_string_lossy().to_string(), 1)
            } else {
                s
            }
        });
    write(&InstalledCore {
        bin: std::path::PathBuf::from(new_txt),
        prefix: prefix_txt.map(std::path::PathBuf::from),
        version: cur.version,
        source: cur.source,
    });
    true
}

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
