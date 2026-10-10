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
