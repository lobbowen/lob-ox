//! 下载安装管理器（TransferManager）。
//!
//! 定位：**壳侧唯一的取件通路**。环境（Node/未来其它运行时）、内核、桌面壳
//! 三者的下载都从这里走；各自只保留「要什么版本」与「拿到后怎么落定」的编排。
//!
//! 与 process_manager 同构：
//!   - process_manager 收编了内核侧全部进程逻辑，编排留在业务本体；
//!   - transfer 收编全部下载逻辑，编排同样留在业务本体。
//!
//! 划分依据（刻意不做的事）：
//!   - **不含**「该更新哪个组件、什么顺序」——那是产品版本库（ota）的职责；
//!   - **不含**「拿到字节后怎么落定」——Node 要解包换装、内核要走 npm、
//!     壳要验签替换，各不相同，由调用方在自己的编排里完成；
//!   - 只负责「可靠地把字节拿到手并落到暂存区」这一件事。
//!
//! 因此调用形状统一为：
//!     transfer::fetch(&Request { .. }, &mut |done, total| { .. })
//! 而下载源列表、超时、校验算法都由调用方声明 —— 差异留在参数里，不留在分支里。

pub mod fetch;
pub mod source;
pub mod verify;

use std::path::PathBuf;

/// 一次取件请求。调用方声明「要什么、从哪下、怎么算校验」，
/// 落定方式不在此列 —— 那由调用方拿到字节后自行完成。
#[derive(Debug, Clone)]
pub struct Request {
    /// 产物落地路径（暂存区）。取件成功后字节写在此处。
    pub dest: PathBuf,
    /// 超时。不同来源差异很大（npm 包小、发行版安装包大），由调用方给。
    pub timeout: std::time::Duration,
    /// 期望字节数。给出则作为「取回是否完整」的第一道判据。
    pub expect_size: Option<u64>,
    /// 摘要校验。None 表示该产物无可用摘要（调用方需自行承担完整性判断）。
    pub verify: Option<verify::Expectation>,
}

impl Request {
    pub fn new(dest: impl Into<PathBuf>) -> Self {
        Self {
            dest: dest.into(),
            timeout: std::time::Duration::from_secs(300),
            expect_size: None,
            verify: None,
        }
    }

    pub fn timeout(mut self, d: std::time::Duration) -> Self {
        self.timeout = d;
        self
    }

    pub fn expect_size(mut self, n: u64) -> Self {
        self.expect_size = Some(n);
        self
    }

    pub fn verify(mut self, e: verify::Expectation) -> Self {
        self.verify = Some(e);
        self
    }
}

/// 取件结果。
#[derive(Debug, Clone)]
pub struct Fetched {
    /// 实际落地的文件（== Request::dest）。
    pub path: PathBuf,
    pub bytes: u64,
    /// 是否命中了「已缓存」而未真正走网络。
    pub from_cache: bool,
    /// 最终成功的源；为空表示全部源都试过但没有一次给出可接受的字节。
    pub source: Option<String>,
}

/// 取件的统一入口。
///
/// 依次尝试 `candidates`：某个源失败就换下一个；全部失败则返回最后一个原因。
/// 进度回调在每次尝试开始时以 (0, expect) 触发一次，便于 UI 把进度条归零。
pub fn fetch(
    urls: &[source::Candidate],
    req: &Request,
    on_progress: &dyn Fn(u64, Option<u64>),
) -> Result<Fetched, String> {
    if urls.is_empty() {
        return Err("没有可用的下载源".to_string());
    }
    fetch::run(urls, req, on_progress)
}

/// 暂存区。落在 state_root 下，与最终安装位置分离 ——
/// 取件没验过之前绝不进入安装目录。
pub fn staging_dir() -> PathBuf {
    crate::env::supervisor_dir().join("transfer")
}

/// 清掉某个产物名对应的暂存文件（下次取件会重新下载）。
pub fn discard(name: &str) {
    let _ = std::fs::remove_file(staging_dir().join(name));
}