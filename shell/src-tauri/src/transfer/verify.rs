//! 摘要校验。各来源的摘要强度不同，这里只提供算法，不决定用哪个 ——
//! 用哪个由调用方在自己的编排里声明（Node 用 SHA256、npm 包用 SHA512、
//! 桌面壳用 minisign 签名）。

use sha2::Digest;

/// 期望的摘要。`None` 表示「这一项不参与判定」。
#[derive(Debug, Clone)]
pub enum Expectation {
    /// 十六进制 SHA256。
    Sha256(String),
    /// 十六进制 SHA512。
    Sha512(String),
}

impl Expectation {
    /// 按期望校验字节；不符返回可读的差异说明。
    pub fn check(&self, data: &[u8]) -> Result<(), String> {
        match self {
            Expectation::Sha256(want) => {
                let got = hex::encode(sha2::Sha256::digest(data));
                compare("SHA256", want, &got)
            }
            Expectation::Sha512(want) => {
                let got = hex::encode(sha2::Sha512::digest(data));
                compare("SHA512", want, &got)
            }
        }
    }

    /// 从 SHASUMS256.txt 的一行里取出某个文件的摘要。
    /// 行格式为 `<64位hex>  <文件名>`，与 nodejs.org 的约定一致。
    pub fn from_shasums_line(line: &str, file: &str) -> Option<Expectation> {
        let l = line.trim();
        let mut it = l.split_whitespace();
        let hexsum = it.next()?;
        let name = it.next()?;
        let name = name.trim_start_matches('*');
        if name != file || hexsum.len() != 64 {
            return None;
        }
        if !hexsum.chars().all(|c| c.is_ascii_hexdigit()) {
            return None;
        }
        Some(Expectation::Sha256(hexsum.to_string()))
    }
}

fn compare(algo: &str, want: &str, got: &str) -> Result<(), String> {
    if want.eq_ignore_ascii_case(got) {
        return Ok(());
    }
    Err(format!(
        "{} 校验失败：期望 {}，实得 {}（字节与来源声明的摘要不符，拒绝落定）",
        algo,
        short(want),
        short(got)
    ))
}

fn short(h: &str) -> String {
    if h.len() <= 16 {
        h.to_string()
    } else {
        format!("{}…", &h[..16])
    }
}