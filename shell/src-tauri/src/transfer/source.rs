//! 下载源。多源回退的**形状**在这里，具体源列表由各业务自己给
//! （环境走 mirror 的 node 源、内核走 registry origins、壳走 artifact_candidates）。
//!
//! 为什么源列表不集中在这里：
//! 把「有哪些源」写死到这个模块，就等于把三类产品的发布渠道耦在一起了 ——
//! 而它们本就不同。收敛的是「拿到候选源之后怎么依次试」，不是「候选源是什么」。

/// 一个下载地址及其归属标签。
#[derive(Debug, Clone)]
pub struct Candidate {
    /// 完整 URL（含路径与文件名）。
    pub url: String,
    /// 人类可读的来源名，进日志与错误信息。
    pub label: String,
}

impl Candidate {
    pub fn new(url: impl Into<String>, label: impl Into<String>) -> Self {
        Self { url: url.into(), label: label.into() }
    }
}

/// 按给定顺序去重。顺序即优先级：首个可达且字节可接受的源胜出。
pub fn dedup(cands: Vec<Candidate>) -> Vec<Candidate> {
    let mut out: Vec<Candidate> = Vec::with_capacity(cands.len());
    for c in cands {
        if !out.iter().any(|x| x.url == c.url) {
            out.push(c);
        }
    }
    out
}

/// 从「基址 + 版本目录 + 文件名」拼出一个源。
pub fn under(base: &str, version: &str, file: &str) -> Candidate {
    let b = base.trim_end_matches('/');
    let v = version.trim_start_matches('v');
    Candidate::new(
        format!("{}/{}/{}", b, v, file),
        format!("{}/{}/{}", b, v, file),
    )
}