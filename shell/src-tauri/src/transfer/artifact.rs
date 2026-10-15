//! 产物的落定：把暂存文件放到最终位置，且保证「要么是新的，要么是旧的，
//! 不会是半份」。
//!
//! 三类产物的落定方式不同（Node 解包后换装目录、内核交给 npm、
//! 桌面壳验签后替换可执行文件），所以本模块只提供**它们共用的那一步**：
//! 在同一个位置把暂存文件改名成正式文件。改名是原子的；
//! 先删再改名则会在中途失败时把产物变成「没有」。

use std::path::{Path, PathBuf};

/// 原子替换一个文件。
///
/// `dest` 已存在时先移开再改名；移开失败则中止，**不删原文件** ——
/// 那可能正被运行中的进程占用（Windows 会锁住在用的 exe）。
pub fn replace_file(staged: &Path, dest: &Path) -> Result<(), String> {
    if !staged.is_file() {
        return Err(format!("暂存产物不存在: {}", staged.display()));
    }
    if let Some(p) = dest.parent() {
        std::fs::create_dir_all(p).map_err(|e| format!("创建目录失败: {}", e))?;
    }
    let backup = backup_path(dest);
    let had = dest.exists();
    if had {
        let _ = std::fs::remove_file(&backup);
        if let Err(e) = std::fs::rename(dest, &backup) {
            return Err(format!(
                "既有产物被占用，无法移开（{}）: {}。该文件可能正被运行中的进程使用；请关闭占用它的程序后重试。既有产物未被删除。",
                dest.display(), e
            ));
        }
    }
    match std::fs::rename(staged, dest) {
        Ok(()) => {
            if had {
                let _ = std::fs::remove_file(&backup);
            }
            Ok(())
        }
        Err(e) => {
            if had {
                let _ = std::fs::remove_file(dest);
                if let Err(re) = std::fs::rename(&backup, dest) {
                    return Err(format!(
                        "落定失败且回滚也失败：新产物未就位，旧产物仍在 {}",
                        backup.display()
                    ));
                }
            }
            Err(format!("落定 {} 失败: {}", dest.display(), e))
        }
    }
}

fn backup_path(dest: &Path) -> PathBuf {
    let name = dest.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    let parent = dest.parent().map(|p| p.to_path_buf()).unwrap_or_default();
    parent.join(format!("{}.prev", name))
}