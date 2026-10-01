//! 本地 HTTP 客户端（与内核对齐的最小实现），只服务壳与内核之间的本机回环交互（握手、会话态、停止握手）。不引 reqwest/ureq：请求极简（无 TLS / 无重定向 / 无连接复用），壳是安装器，少一个依赖就少一份供应链与体积负担。必须用 connect_timeout（防火墙 DROP 时裸 connect 会等到 SYN 重试耗尽，Windows 默认 20+ 秒）并设读写超时；托盘回调里的网络 I/O 一律经 spawn_local_post 派发，否则整个界面含重绘冻结。
use std::net::TcpStream;

pub(crate) fn post_local(port: u16, path: &str) {
    let _ = post_local_timeout(port, path, std::time::Duration::from_secs(60));
}

pub(crate) fn spawn_local_post(port: u16, path: &'static str) {
    std::thread::spawn(move || post_local(port, path));
}

pub(crate) fn connect_local(port: u16, timeout: std::time::Duration) -> Option<TcpStream> {
    use std::net::ToSocketAddrs;
    let addr = format!("127.0.0.1:{}", port);
    let sa = addr.to_socket_addrs().ok()?.next()?;
    TcpStream::connect_timeout(&sa, timeout).ok()
}

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

/// 本地 HTTP GET，返回 (状态码, 全文)，供守卫就绪探针用。`None` = 这次问不出状态码：连不上、写不进去、或对方一个字节都没回；不得把「没有状态行」糊成 `(0, "")`（那会让「端口通了但服务没起来」与「服务回了 5xx」变成同一句话）。
pub(crate) fn http_get_local(port: u16, path: &str, timeout: std::time::Duration) -> Option<(u16, String)> {
    let mut stream = connect_local(port, LOCAL_CONNECT_TIMEOUT)?;
    let _ = stream.set_read_timeout(Some(timeout));
    let _ = stream.set_write_timeout(Some(timeout));
    let req = format!("GET {} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nConnection: close\r\n\r\n", path, port);
    std::io::Write::write_all(&mut stream, req.as_bytes()).ok()?;
    let mut buf = Vec::new();
    let _ = std::io::Read::read_to_end(&mut stream, &mut buf);
    let s = String::from_utf8_lossy(&buf).into_owned();
    let code = s.split_whitespace().nth(1)?.parse::<u16>().ok()?;
    Some((code, s))
}

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
