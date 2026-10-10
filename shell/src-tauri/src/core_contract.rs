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
