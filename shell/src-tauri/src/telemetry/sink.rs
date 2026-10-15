//! 事件落盘。形态照搬内核 events.js，其数据正确性不变式整套保留。

use super::{shell_events_path, Event};
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;

const MAX_BYTES: u64 = 5 * 1024 * 1024;
const META_SAVE_EVERY: u64 = 32;

/// 单写者。壳侧事件量远小于内核（每秒个位数而非数百），
/// 单锁足够；换来的是 seq 的推进与落盘严格串行 —— seq 不变式的前提。
static SINK: Mutex<Option<State>> = Mutex::new(None);

struct State {
    file: PathBuf,
    seq: u64,
    rotated_seq: u64,
    size: u64,
    meta_saved_seq: u64,
}

fn with<R>(f: impl FnOnce(&mut State) -> R) -> R {
    let mut g = SINK.lock().unwrap_or_else(|e| e.into_inner());
    if g.is_none() {
        *g = Some(State::open(shell_events_path()));
    }
    let st = g.as_mut().expect("刚初始化");
    f(st)
}

impl State {
    fn open(file: PathBuf) -> State {
        let mut st = State {
            file,
            seq: 0,
            rotated_seq: 0,
            size: 0,
            meta_saved_seq: 0,
        };
        st.load_meta();
        st.size = st.file_size();
        let from_disk = st.max_seq();
        if from_disk > st.seq {
            st.seq = from_disk;
        }
        st.meta_saved_seq = st.seq;
        st
    }

    fn meta_path(&self) -> PathBuf {
        let mut p = self.file.as_os_str().to_os_string();
        p.push(".meta.json");
        PathBuf::from(p)
    }

    fn load_meta(&mut self) {
        let Ok(s) = std::fs::read_to_string(self.meta_path()) else { return };
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&s) else { return };
        if let Some(n) = v.get("seq").and_then(|x| x.as_u64()) {
            self.seq = self.seq.max(n);
        }
        if let Some(n) = v.get("rotatedSeq").and_then(|x| x.as_u64()) {
            self.rotated_seq = n;
        }
    }

    fn save_meta(&mut self) {
        let body = serde_json::json!({ "seq": self.seq, "rotatedSeq": self.rotated_seq });
        let _ = crate::atomic_write::write(&self.meta_path(), &body.to_string());
        self.meta_saved_seq = self.seq;
    }

    fn file_size(&self) -> u64 {
        std::fs::metadata(&self.file).map(|m| m.len()).unwrap_or(0)
    }

    /// 从主文件尾部反查最大 seq（只读末尾 8 KiB），避免全量扫描。
    fn max_seq(&self) -> u64 {
        let Ok(md) = std::fs::metadata(&self.file) else { return 0 };
        let size = md.len();
        if size == 0 {
            return 0;
        }
        let from = size.saturating_sub(8192);
        let Ok(mut f) = std::fs::File::open(&self.file) else { return 0 };
        use std::io::{Read, Seek, SeekFrom};
        let mut buf = vec![0u8; (size - from) as usize];
        if f.seek(SeekFrom::Start(from)).and_then(|_| f.read_exact(&mut buf)).is_err() {
            return 0;
        }
        let text = String::from_utf8_lossy(&buf);
        for line in text.lines().rev() {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(line) {
                if let Some(n) = v.get("seq").and_then(|x| x.as_u64()) {
                    return n;
                }
            }
        }
        0
    }

    fn rotate_if_needed(&mut self) {
        if self.size < MAX_BYTES {
            return;
        }
        let mut backup = self.file.as_os_str().to_os_string();
        backup.push(".1");
        let backup = PathBuf::from(backup);
        // 记下「备份文件现在包含到哪个序号」：增量读据此判断是否需要扫备份。
        // 壳侧此前的截断重写没有等价物，跨重启的增量读会重复或漏读。
        self.rotated_seq = self.seq;
        let _ = std::fs::rename(&self.file, &backup);
        self.size = 0;
        self.save_meta();
    }
}

/// 追加一条事件。返回落盘后的 seq。
///
/// **seq 只在写盘成功后前进** —— 这是内核 events.js 修过一次「永久丢事件」的核心不变式：
/// 一旦无条件推进，meta 与磁盘不一致时 watermark 会跳过区间，事件永久丢失且无法察觉。
pub fn append(ev: &Event) -> Option<u64> {
    with(|st| {
        st.rotate_if_needed();
        if let Some(p) = st.file.parent() {
            let _ = std::fs::create_dir_all(p);
        }
        let mut line = ev.clone();
        line.seq = st.seq + 1;
        let body = match serde_json::to_string(&line) {
            Ok(s) => s,
            Err(_) => return None,
        };
        let mut f = match std::fs::OpenOptions::new().create(true).append(true).open(&st.file) {
            Ok(f) => f,
            Err(_) => return None,
        };
        if f.write_all(body.as_bytes()).and_then(|_| f.write_all(b"\n")).is_err() {
            return None;
        }
        let _ = f.flush();
        st.size += body.len() as u64 + 1;
        st.seq = line.seq;
        if st.seq.saturating_sub(st.meta_saved_seq) >= META_SAVE_EVERY {
            st.save_meta();
        }
        Some(st.seq)
    })
}

/// 当前已分配的最大 seq。
pub fn current_seq() -> u64 {
    with(|st| st.seq)
}

/// 备份文件（轮转前）的边界序号。
pub fn rotated_seq() -> u64 {
    with(|st| st.rotated_seq)
}