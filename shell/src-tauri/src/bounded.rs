//! 有界子进程执行（公共设施）：全仓外部命令一律经此文件，`.output()` 这类无界调用统一包装为超时 + kill。
//! 输出重定向到临时文件而非管道（不抽读的管道填满 64KB 后子进程会阻塞成死锁）；超时用轮询 try_wait 实现（std 无跨平台 wait-with-timeout，挂起后同步 wait 就是无界的）。

use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

pub struct ExecRecord {
    pub program: String,
    pub args: Vec<String>,
    pub timed_out: bool,
    pub timeout_secs: u64,
    pub code: Option<i32>,
    pub success: bool,
    pub stdout: String,
    pub stderr: String,
}

impl ExecRecord {
    /// 人可读正文：stderr 优先，为空才回退 stdout（两路都不丢）。
    pub fn detail(&self) -> &str {
        let e = self.stderr.trim();
        if !e.is_empty() {
            return e;
        }
        self.stdout.trim()
    }

    pub fn command_line(&self) -> String {
        cmd_line_of(&self.program, &self.args)
    }

    /// 退出状态的统一措辞；调用点不得各自再拼一份。
    pub fn code_label(&self) -> String {
        if self.timed_out {
            return format!("超时被终止（>{}s）", self.timeout_secs);
        }
        match self.code {
            Some(c) => format!("退出码 {}", c),
            None => "被终止（无退出码）".to_string(),
        }
    }

    pub fn failure(&self, what: &str) -> String {
        let detail = self.detail();
        format!(
            "{} 失败（{} · {}）：{}",
            what,
            self.code_label(),
            self.command_line(),
            if detail.is_empty() { "子进程无任何输出".to_string() } else { tail(detail, 700) }
        )
    }

    pub fn ok_or_stderr(self, what: &str) -> Result<String, String> {
        if self.success {
            Ok(self.stdout.trim().to_string())
        } else {
            Err(self.failure(what))
        }
    }
}

fn cmd_line_of(program: &str, args: &[String]) -> String {
    if args.is_empty() {
        return program.to_string();
    }
    format!("{} {}", program, args.join(" "))
}

pub fn prepare(cmd: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    #[cfg(not(windows))]
    {
        let _ = cmd;
    }
}

/// Windows 上 npm 类命令是 `npm.cmd` -> cmd.exe -> node.exe 三层：只杀直接子进程等于只杀 cmd.exe，孙进程仍占着端口与状态根（非 Windows 无这一层）。
pub fn kill_tree(child: &mut std::process::Child) {
    #[cfg(windows)]
    {
        let mut tk = Command::new("taskkill");
        tk.args(["/PID", &child.id().to_string(), "/T", "/F"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        prepare(&mut tk);
        let _ = tk.status();
    }
    #[cfg(not(windows))]
    {
        let _ = child.kill();
    }
}

pub struct Live {
    pub elapsed: Duration,
    pub lines: usize,
    pub last_line: String,
}

/// 与 [`run`] 的唯一区别是这条心跳；二者共用 [`run_inner`]，行为不可能分叉。
pub fn run_watch(
    cmd: &mut Command,
    timeout: Duration,
    heartbeat: Duration,
    on_live: &dyn Fn(&Live),
) -> Result<ExecRecord, String> {
    run_inner(cmd, timeout, Some((heartbeat, on_live)))
}

/// 只有「没能跑起来」才是 Err；「跑完了但没成功」（含超时被杀）一律返回 Ok(记录)：输出与退出状态作为证据保留，调用方才能区分「命令不存在」与「命令挂了」。
pub fn run(cmd: &mut Command, timeout: Duration) -> Result<ExecRecord, String> {
    run_inner(cmd, timeout, None)
}

fn run_inner(
    cmd: &mut Command,
    timeout: Duration,
    watch: Option<(Duration, &dyn Fn(&Live))>,
) -> Result<ExecRecord, String> {
    // 命令原文在此捕获，不让每个调用方自己记得带上：这是「诊断必含命令」的唯一保证。
    let program = cmd.get_program().to_string_lossy().into_owned();
    let args: Vec<String> = cmd.get_args().map(|a| a.to_string_lossy().into_owned()).collect();
    let timeout_secs = timeout.as_secs();
    let cmd_line = cmd_line_of(&program, &args);
    let dir = std::env::temp_dir();
    let stamp = format!(
        "{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    );
    let out_path = dir.join(format!("dsh-cmd-out-{}.log", stamp));
    let err_path = dir.join(format!("dsh-cmd-err-{}.log", stamp));

    let out_file = std::fs::File::create(&out_path)
        .map_err(|e| format!("{} 无法执行（创建临时输出文件失败）: {}", cmd_line, e))?;
    // 不变量：任一临时文件创建失败或 spawn 失败时，必须清掉已建的文件（不留残渣）。
    let err_file = match std::fs::File::create(&err_path) {
        Ok(f) => f,
        Err(e) => {
            cleanup(&out_path, &err_path);
            return Err(format!("{} 无法执行（创建临时错误文件失败）: {}", cmd_line, e));
        }
    };
    cmd.stdout(Stdio::from(out_file));
    cmd.stderr(Stdio::from(err_file));
    cmd.stdin(Stdio::null());
    prepare(cmd);

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            cleanup(&out_path, &err_path);
            return Err(format!("{} 无法启动: {}", cmd_line, e));
        }
    };

    let start = Instant::now();
    let mut next_beat = start;
    let status = loop {
        match child.try_wait() {
            Ok(Some(st)) => break st,
            Ok(None) => {
                if start.elapsed() >= timeout {
                    kill_tree(&mut child);
                    let _ = child.wait();
                    let err = read_log(&err_path);
                    let out = read_log(&out_path);
                    cleanup(&out_path, &err_path);
                    return Ok(ExecRecord {
                        program,
                        args,
                        timed_out: true,
                        timeout_secs,
                        code: None,
                        success: false,
                        stdout: out,
                        stderr: err,
                    });
                }
                if let Some((heartbeat, on_live)) = watch {
                    let now = Instant::now();
                    if now >= next_beat {
                        next_beat = now + heartbeat;
                        on_live(&live_of(&out_path, &err_path, now - start));
                    }
                }
                std::thread::sleep(Duration::from_millis(25));
            }
            Err(e) => {
                kill_tree(&mut child);
                let _ = child.wait();
                cleanup(&out_path, &err_path);
                return Err(format!("{} 等待子进程失败: {}", cmd_line, e));
            }
        }
    };

    let stdout = read_log(&out_path);
    let stderr = read_log(&err_path);
    cleanup(&out_path, &err_path);
    Ok(ExecRecord {
        program,
        args,
        timed_out: false,
        timeout_secs,
        code: status.code(),
        success: status.success(),
        stdout,
        stderr,
    })
}

fn live_of(out_path: &std::path::Path, err_path: &std::path::Path, elapsed: Duration) -> Live {
    let out = read_log(out_path);
    let err = read_log(err_path);
    let mut lines = 0usize;
    let mut last_line = String::new();
    for l in out.lines().chain(err.lines()) {
        let t = l.trim();
        if t.is_empty() {
            continue;
        }
        lines += 1;
        last_line = t.to_string();
    }
    Live { elapsed, lines, last_line }
}

pub fn run_checked(cmd: &mut Command, timeout: Duration, what: &str) -> Result<String, String> {
    run(cmd, timeout)?.ok_or_stderr(what)
}

pub fn run_lossy(cmd: &mut Command, timeout: Duration) {
    let _ = run(cmd, timeout);
}

fn read_log(p: &std::path::Path) -> String {
    match std::fs::read(p) {
        Ok(bytes) => decode_console(&bytes),
        Err(_) => String::new(),
    }
}

/// 子进程原始字节 -> 字符串，全仓唯一解码点：Windows 控制台程序按 OEM 码页写 stderr，按 UTF-8 lossy 解码会把双字节换成 U+FFFD，故先试 UTF-8，失败交操作系统按当前控制台码页转换，仍失败才 lossy 保底。
#[cfg(windows)]
fn decode_console(bytes: &[u8]) -> String {
    if bytes.is_empty() {
        return String::new();
    }
    if let Ok(s) = std::str::from_utf8(bytes) {
        return s.to_string();
    }
    match decode_codepage(bytes, console_code_page()) {
        Some(s) => s,
        None => String::from_utf8_lossy(bytes).into_owned(),
    }
}

/// GUI 子系统没有控制台时 `GetConsoleOutputCP` 返回 0，回退系统 OEM 码页。
#[cfg(windows)]
fn console_code_page() -> u32 {
    extern "system" {
        fn GetConsoleOutputCP() -> u32;
        fn GetOEMCP() -> u32;
    }
    let c = unsafe { GetConsoleOutputCP() };
    if c == 0 {
        unsafe { GetOEMCP() }
    } else {
        c
    }
}

/// 允许显式传码页：回归用例须任意语言的 runner 上确定性复现，绑在 runner 码页上会跟着机器抖。
#[cfg(windows)]
fn decode_codepage(bytes: &[u8], cp: u32) -> Option<String> {
    extern "system" {
        fn MultiByteToWideChar(
            code_page: u32,
            flags: u32,
            multi_byte_str: *const i8,
            multi_byte_len: i32,
            wide_char_str: *mut u16,
            wide_char_len: i32,
        ) -> i32;
    }
    let len = bytes.len().min(i32::MAX as usize) as i32;
    let src = bytes.as_ptr() as *const i8;
    let need = unsafe { MultiByteToWideChar(cp, 0, src, len, std::ptr::null_mut(), 0) };
    if need <= 0 {
        return None;
    }
    let mut wide = vec![0u16; need as usize];
    let got = unsafe { MultiByteToWideChar(cp, 0, src, len, wide.as_mut_ptr(), need) };
    if got <= 0 {
        return None;
    }
    Some(String::from_utf16_lossy(&wide[..got as usize]))
}

#[cfg(not(windows))]
fn decode_console(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

fn cleanup(a: &std::path::Path, b: &std::path::Path) {
    let _ = std::fs::remove_file(a);
    let _ = std::fs::remove_file(b);
}

fn tail(s: &str, n: usize) -> String {
    let t = s.trim();
    if t.chars().count() <= n {
        return t.to_string();
    }
    let skip = t.chars().count() - n;
    t.chars().skip(skip).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

        /// 本模块的测试串行执行（锁见下）：有用例要数 temp 目录里的 dsh-cmd-*.log，并发用例的创建/清理会让计数抖动、断言误失败。
    static SERIAL: std::sync::Mutex<()> = std::sync::Mutex::new(());

    #[test]
    fn bounded_run_success() {
        let _g = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        let mut c = Command::new(if cfg!(windows) { "cmd" } else { "echo" });
        if cfg!(windows) {
            c.args(["/C", "echo hello"]);
        } else {
            c.arg("hello");
        }
        let out = run(&mut c, Duration::from_secs(5)).expect("run");
        assert!(out.success, "stderr={}", out.stderr);
        assert!(out.stdout.contains("hello"), "stdout={}", out.stdout);
    }

    #[test]
    fn bounded_run_reports_timeout_as_evidence_not_error() {
        let _g = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        let mut c = Command::new(if cfg!(windows) { "cmd" } else { "sleep" });
        if cfg!(windows) {
            c.args(["/C", "ping -n 30 127.0.0.1 >NUL"]);
        } else {
            c.arg("30");
        }
        let started = Instant::now();
        let r = run(&mut c, Duration::from_millis(600)).expect("超时应返回记录，而非 Err");
        let el = started.elapsed();
        assert!(r.timed_out, "timed_out 未置位: {:?}", r.code);
        assert!(!r.success, "超时不得被判为成功");
        assert_eq!(r.code, None, "被终止不应有退出码");
        assert!(r.code_label().starts_with("超时被终止"), "措辞: {}", r.code_label());
        assert!(!r.command_line().is_empty(), "记录必须含命令原文");
        assert!(el < Duration::from_secs(10), "耗时过长: {:?}", el);
    }

    #[test]
    fn exec_record_failure_renders_command_and_code_once() {
            // 命令原文刻意用中性程序：本仓不得再出现 OS 服务机制（schtasks/systemctl/launchctl）的字样。
        let r = ExecRecord {
            program: "lobox-shell".into(),
            args: vec!["--run-guard".into()],
            timed_out: false,
            timeout_secs: 10,
            code: Some(1),
            success: false,
            stdout: String::new(),
            stderr: "  系统找不到指定的文件。  ".into(),
        };
        let msg = r.failure("服务管理器启动");
        assert!(msg.contains("服务管理器启动 失败"), "{}", msg);
        assert!(msg.contains("退出码 1"), "{}", msg);
        assert!(msg.contains("lobox-shell --run-guard"), "缺命令原文: {}", msg);
        assert!(msg.ends_with("系统找不到指定的文件。"), "{}", msg);
        let fallback = ExecRecord { stdout: "only-stdout".into(), stderr: String::new(), ..r };
        assert_eq!(fallback.detail(), "only-stdout");
    }

    #[test]
    fn decode_console_preserves_utf8_and_empty() {
        // 三平台共同契约：UTF-8（node/npm 的输出）必须逐字节等价，不得被二次转换弄脏。
        assert_eq!(decode_console(b""), "");
        assert_eq!(decode_console("内核已对齐 v0.1.5".as_bytes()), "内核已对齐 v0.1.5");
        assert_eq!(decode_console(b"plain ascii"), "plain ascii");
    }

        /// 中文 Windows 现场回归（GBK/cp936 字节）：显式传 936 而不走 decode_console —— runner 的控制台码页由机器决定，判据绑在它上会跟着机器抖。
    #[cfg(windows)]
    #[test]
    fn decode_console_reads_gbk_console_output() {
        const GBK: &[u8] = &[
            0xCF, 0xB5, 0xCD, 0xB3, 0xD5, 0xD2, 0xB2, 0xBB, 0xB5, 0xBD, 0xD6, 0xB8, 0xB6, 0xA8,
            0xB5, 0xC4, 0xCE, 0xC4, 0xBC, 0xFE, 0xA1, 0xA3,
        ];
        assert_eq!(decode_codepage(GBK, 936).as_deref(), Some("系统找不到指定的文件。"));
        assert!(!String::from_utf8_lossy(GBK).contains("系统"));
    }

    #[test]
    fn run_watch_emits_heartbeats_while_the_child_runs() {
        let _g = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        let mut c = Command::new(if cfg!(windows) { "cmd" } else { "sh" });
        if cfg!(windows) {
            c.args(["/C", "echo started & ping -n 6 127.0.0.1 >NUL"]);
        } else {
            c.args(["-c", "echo started; sleep 3"]);
        }
        let beats: std::sync::Mutex<Vec<(u64, usize, String)>> = std::sync::Mutex::new(vec![]);
        let r = run_watch(
            &mut c,
            Duration::from_secs(30),
            Duration::from_millis(150),
            &|l: &Live| {
                beats.lock().unwrap_or_else(|e| e.into_inner())
                    .push((l.elapsed.as_millis() as u64, l.lines, l.last_line.clone()));
            },
        )
        .expect("run_watch");
        assert!(r.success, "stderr={}", r.stderr);
        let b = beats.lock().unwrap_or_else(|e| e.into_inner()).clone();
        assert!(b.len() >= 2, "子进程运行期间没有持续心跳：{:?}", b);
        assert!(b.last().unwrap().0 > b[0].0, "心跳时长未前进：{:?}", b);
        assert!(b.last().unwrap().1 >= 1, "未统计到子进程输出行：{:?}", b);
        assert!(b.last().unwrap().2.contains("started"), "末行不是真实输出：{:?}", b);
    }

    #[test]
    fn missing_binary_is_error_not_panic() {
        let _g = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        let mut c = Command::new("dsh-no-such-binary-xyz");
        assert!(run(&mut c, Duration::from_secs(2)).is_err());
    }

    #[test]
    fn a4_spawn_failure_leaves_no_temp_logs() {
        let _g = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        let dir = std::env::temp_dir();
        let before = count_dsh_cmd_logs(&dir);
        let mut c = Command::new("dsh-no-such-binary-xyz");
        let r = run(&mut c, Duration::from_secs(2));
        assert!(r.is_err(), "前置：不存在的命令应失败");
        let after = count_dsh_cmd_logs(&dir);

        assert!(
            after <= before,
            "A-4 FAIL spawn 失败后 temp 日志未清理（之前 {} 个，之后 {} 个）",
            before,
            after
        );
    }

    fn count_dsh_cmd_logs(dir: &std::path::Path) -> usize {
        std::fs::read_dir(dir)
            .map(|rd| {
                rd.flatten()
                    .filter(|e| {
                        let n = e.file_name().to_string_lossy().to_string();
                        n.starts_with("dsh-cmd-out-") || n.starts_with("dsh-cmd-err-")
                    })
                    .count()
            })
            .unwrap_or(0)
    }
}

pub fn exit_code_label(code: Option<i32>) -> String {
    match code {
        Some(c) => format!("退出码 {}", c),
        None => "被终止（无退出码）".to_string(),
    }
}
