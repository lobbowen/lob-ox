//! 本地 HTTP 客户端（与内核对齐的最小实现），只服务壳与内核之间的本机回环交互（握手、会话态、停止握手）。
//! 不引 reqwest/ureq：请求极简（无 TLS / 无重定向 / 无连接复用），而壳是安装器，少一个依赖就少一份供应链与体积负担。
//! 连接必须用 connect_timeout（防火墙 DROP 时裸 connect 会等到 SYN 重试耗尽，Windows 默认 20+ 秒），读写必须设超时；
//! 托盘回调里的网络 I/O 一律经 spawn_local_post 派发，否则整个界面含重绘冻结。
use std::net::TcpStream;

pub(crate) fn post_local(port: u16, path: &str) {
    let _ = post_local_timeout(port, path, std::time::Duration::from_secs(60));
}

/// 把本地 API 调用派发到独立线程，绝不阻塞 UI 线程：托盘菜单等由 UI 线程派发的回调一旦阻塞，
/// 整个界面（含重绘）都被冻结，观感是「点击无反应」。退出流程同样经此派发，守卫无响应时菜单也立即响应。
pub(crate) fn spawn_local_post(port: u16, path: &'static str) {
    std::thread::spawn(move || post_local(port, path));
}

/// 与本地守卫建立连接，带连接超时，返回响应体（utf8 尽力解码）。
/// 必须用 connect_timeout：`TcpStream::connect` 没有超时，端口被防火墙 DROP（而非 REJECT）时会一直等到
/// 操作系统 SYN 重试耗尽，Windows 默认可达 20+ 秒。本函数被 guard_ready（引导页 500ms 轮询、最多 40 次）
/// 与托盘动作调用，等同于反复长时间阻塞；回环正常时是微秒级，但不能用「正常时很快」省略上限。
pub(crate) fn connect_local(port: u16, timeout: std::time::Duration) -> Option<TcpStream> {
    use std::net::ToSocketAddrs;
    let addr = format!("127.0.0.1:{}", port);
    let sa = addr.to_socket_addrs().ok()?.next()?;
    TcpStream::connect_timeout(&sa, timeout).ok()
}

/// 本地 HTTP 请求的连接预算（回环地址，正常为微秒级；此处仅作兜底上限）。
const LOCAL_CONNECT_TIMEOUT: std::time::Duration = std::time::Duration::from_millis(800);

pub(crate) fn post_local_timeout(port: u16, path: &str, timeout: std::time::Duration) -> Option<String> {
    let mut stream = connect_local(port, LOCAL_CONNECT_TIMEOUT)?;
    let _ = stream.set_read_timeout(Some(timeout));
    let _ = stream.set_write_timeout(Some(timeout));
    let req = format!(
        "POST {} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        path, port
    );
    std::io::Write::write_all(&mut stream, req.as_bytes()).ok()?;
    let mut buf = Vec::new();
    let _ = std::io::Read::read_to_end(&mut stream, &mut buf);
    Some(String::from_utf8_lossy(&buf).into_owned())
}

/// 本地 HTTP GET，返回 (状态码, 全文)，供守卫就绪探针用。
/// `None` = 这次问不出状态码：连不上、写不进去、或对方一个字节都没回。不得把「没有状态行」糊成
/// `(0, "")` —— 那会让「端口通了但服务没起来」与「服务回了 5xx」变成同一句话，而前者该再等、后者该去看日志。
pub(crate) fn http_get_local(port: u16, path: &str, timeout: std::time::Duration) -> Option<(u16, String)> {
    let mut stream = connect_local(port, LOCAL_CONNECT_TIMEOUT)?;
    let _ = stream.set_read_timeout(Some(timeout));
    let _ = stream.set_write_timeout(Some(timeout));
    let req = format!("GET {} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nConnection: close\r\n\r\n", path, port);
    std::io::Write::write_all(&mut stream, req.as_bytes()).ok()?;
    let mut buf = Vec::new();
    let _ = std::io::Read::read_to_end(&mut stream, &mut buf);
    let s = String::from_utf8_lossy(&buf).into_owned();
  // 状态行固定是 `HTTP/1.1 <code> <reason>`：状态码是**第二个**空白段（第一段是版本）。
    let code = s.split_whitespace().nth(1)?.parse::<u16>().ok()?;
    Some((code, s))
}

/// 读取会话态（GET /session/status 的最小解析：找 "sessionState":"xxx"）。
pub(crate) fn get_session_state(port: u16) -> Option<String> {
    let mut stream = connect_local(port, LOCAL_CONNECT_TIMEOUT)?;
    let _ = stream.set_read_timeout(Some(std::time::Duration::from_secs(3)));
    let _ = stream.set_write_timeout(Some(std::time::Duration::from_secs(3)));
    let req = format!("GET /session/status HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nConnection: close\r\n\r\n", port);
    std::io::Write::write_all(&mut stream, req.as_bytes()).ok()?;
    let mut buf = Vec::new();
    let _ = std::io::Read::read_to_end(&mut stream, &mut buf);
    let s = String::from_utf8_lossy(&buf);
    let key = "\"sessionState\":\"";
    let i = s.find(key)? + key.len();
    let rest = &s[i..];
    let v: String = rest.chars().take_while(|c| c.is_ascii_alphanumeric()).collect();
    if v.is_empty() { None } else { Some(v) }
}
