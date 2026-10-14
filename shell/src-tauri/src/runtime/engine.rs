//! 运行时管理引擎：与「运行时是什么」无关的核心流程。
//!
//! 流程：解析目标版本 -> 下载 -> 校验 -> 解包到 staging -> 切换 -> 记录契约。

use std::path::{Path, PathBuf};

/// 目标解析结果：装哪个版本、装到哪。
#[derive(Debug, Clone)]
