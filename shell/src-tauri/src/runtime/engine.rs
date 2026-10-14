//! 运行时管理引擎：与「运行时是什么」无关的核心流程。
//!
//! 流程：解析目标版本 -> 下载 -> 校验 -> 解包到 staging -> 切换 -> 记录契约。

use std::path::Path;


/// 引擎需要的解包能力（平台差异收敛在这里）。
/// 新增运行时只改配置不改引擎的关键：任何运行时最终都要落到
/// 把归档解开成可执行文件，差异用闭包注入而非在引擎里写平台分支。
pub type Extractor = fn(&Path, &Path) -> Result<(), String>;


/// 切换：把 staging 里解好的目录落到最终位置。
///
/// 关键点（此前踩过的坑）：目标位置可能正被运行中的进程占用
/// （那台机器上 lobox/bin 里就躺着一份正在使用的 node.exe）。
/// Windows 会锁住在用的 exe，rename 直接失败（os error 5 / 145）。
/// 因此：先把旧的移到同盘备份目录；备份失败直接报错且绝不删除旧装
/// ——它可能是用户系统正在用的那一份。新文件已在 staging 就绪是前提，
/// 所以失败最多是没换成，不会是弄丢了。
pub fn swap(staged_bin: &Path, root: &Path, backup: &Path) -> Result<(), String> {
    if !staged_bin.exists() {
        return Err(format!("解包结果不存在: {}", staged_bin.display()));
    }
    let had_prev = root.exists();
    if had_prev {
        let _ = std::fs::remove_dir_all(backup);
        if let Err(e) = std::fs::rename(root, backup) {
            return Err(format!(
                "旧安装目录被占用，无法备份（{}）: {}。",
                root.display(), e
            ));
        }
    }
    if let Err(e) = std::fs::rename(staged_bin, root) {
        if had_prev {
            let _ = std::fs::remove_dir_all(root);
            if let Err(re) = std::fs::rename(backup, root) {
                return Err(format!(
                    "换装失败且回滚也失败：新装 {} 未就位，旧装仍在 {}（{}）",
                    root.display(), backup.display(), re
                ));
            }
            return Err(format!("落定 {} 失败（已回滚到旧安装）: {}", root.display(), e));
        }
        return Err(format!("落定 {} 失败: {}", root.display(), e));
    }
    if had_prev {
        let _ = std::fs::remove_dir_all(backup);
    }
    Ok(())
}
