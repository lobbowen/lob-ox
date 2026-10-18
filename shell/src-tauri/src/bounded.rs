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
        cmd.creation_flags(0x0800_0000); 
    }
    #[cfg(not(windows))]
    {
        let _ = cmd;
    }
}

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

/// pid 是否仍存活（自愈判活的**唯一**实现）。
/// 走系统 API 而非猜：/proc 只在 Linux 有，Windows 上"文件存在"根本不是判据。
#[cfg(windows)]
pub fn pid_alive(pid: u32) -> bool {
    // #[link] 必须贴在 extern 块上（块属性），不能挂在块外的语句位置 ——
    // 放在外面会被解析为块后的一条表达式，链接信息丢失，编译报
    // "cannot find function" 一类的连带错误。
    #[link(name = "kernel32")]
    extern "system" {
        fn OpenProcess(dwDesiredAccess: u32, bInheritHandle: i32, dwProcessId: u32) -> *mut core::ffi::c_void;
        fn GetExitCodeProcess(hProcess: *mut core::ffi::c_void, lpExitCode: *mut u32) -> i32;
        fn CloseHandle(hObject: *mut core::ffi::c_void) -> i32;
    }
    const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
    const STILL_ACTIVE: u32 = 259;
    unsafe {
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if h.is_null() {
            return false;
        }
        let mut code: u32 = 0;
        let ok = GetExitCodeProcess(h, &mut code) != 0;
        CloseHandle(h);
        ok && code == STILL_ACTIVE
    }
}
#[cfg(not(windows))]
pub fn pid_alive(pid: u32) -> bool {
    std::path::Path::new(&format!("/proc/{}", pid)).exists()
}

// ─────────────────────────────────────────────────────────────────────────────
// 件 1（重做）：关机/注销时的「会话结束」守卫（Windows）
//
// 背景（真机验收 FAIL 后用户重裁）：
//   原形态用 `RunEvent::ExitRequested`，而真机验收证明它在 `taskkill`（无 /F）
//   路径上**不触发**——`taskkill` 无 /F 对 GUI 进程（PE Subsystem=2，无控制台）
//   发的是 `WM_CLOSE`，而 `WM_CLOSE` 与「用户点 X」**不可区分**（wParam/lParam
//   都是 0、`GetMessageExtraInfo` 不带来源、发送方不可知）⇒ 形态 A 无解。
//
//   用户重裁：**只接 `WM_QUERYENDSESSION`（关机/注销），`taskkill` 放弃**。
//   理由：`WM_QUERYENDSESSION` (0x0011) 只有关机/注销会发 ⇒ 天然无歧义
//   ⇒ 无产品代价（不碰「关窗口 = 隐藏」特性）。
//
//   而 Tauri v2 **不转** `WM_QUERYENDSESSION`（`WindowEvent` 只有 8 个变体，
//   `RunEvent` 那侧也没有会话结束类）⇒ 必须自己接。
//
// 形态 B（自建 message-only 窗口）而非 A（子类化 Tauri 主窗口）：
//   A 要改 Tauri/webview2 **共用**的 WndProc，改错一个字节整个壳的窗口行为崩；
//   B 自建 `HWND_MESSAGE` 窗口 ⇒ 不可见、不抢焦点、不进任务栏，且**不碰
//   Tauri 的窗口** ⇒ 生命周期自己管（进程级 OnceLock 存 HWND）。
//
// 依赖：**不引入 `windows` / `windows-sys` crate**——它们在 lock 里（5 个
// windows-sys 版本）但 **lock 不记 feature**，而 `CreateWindowExW` 等 API 的
// feature（`Win32_UI_WindowsAndMessaging`）不可控 ⇒ 本机无 cargo 预知不了。
// ⇒ 改用手写 `extern "system"` FFI（与 `pid_alive` / `bind_kill_on_close`
//    同一范式，均已编译过）⇒ 零 feature 风险、零新增下载。
// ─────────────────────────────────────────────────────────────────────────────

/// `WM_QUERYENDSESSION`：关机/注销前 Windows 询问「能否结束会话」。
const WM_QUERYENDSESSION: u32 = 0x0011;
/// `ENDSESSION_CLOSEAPP`：`lParam` 的常见值（应用要关自己）。
const ENDSESSION_CLOSEAPP: u32 = 0x0000_0001;
/// `HWND_MESSAGE`（(HWND)-1）：message-only 父窗口 ⇒ 子窗口不可见、不进任务栏。
const HWND_MESSAGE: isize = -3;

/// 会话结束回调：由 `install_end_session_guard` 的 WndProc 调。
/// 用 `fn` 指针而非闭包 ⇒ 能塞进 `GWLP_USERDATA`（指针宽度）且无生命周期问题。
static END_SESSION_HOOK: std::sync::OnceLock<fn()> = std::sync::OnceLock::new();

/// message-only 窗口的句柄（建失败 = `None`）。刻意不 `DestroyWindow`：
/// 它与壳进程同寿（壳退 ⇒ 窗口随进程销毁，无需我们动手）。
#[cfg(windows)]
static END_SESSION_HWND: std::sync::OnceLock<isize> = std::sync::OnceLock::new();

/// 装「会话结束」守卫（Windows：建 message-only 窗口；非 Windows：无操作）。
///
/// `on_session_ending` 在收到 `WM_QUERYENDSESSION` 时被调（**同步**，见下面
/// 关于 5 秒超时的说明）。
///
/// 幂等：同一进程内重复调用只建一次窗口（`OnceLock`）。
/// 返回 `false` = 没装上（窗口创建失败）⇒ 调用方应记一条 warn，**不当成
/// 致命错误**（关机时杀不掉内核是缺陷，但不该让壳起不来）。
#[cfg(windows)]
pub fn install_end_session_guard(on_session_ending: fn()) -> bool {
    let _ = END_SESSION_HOOK.set(on_session_ending);
    if END_SESSION_HWND.get().is_some() {
        return true; // 已装
    }
    unsafe {
        #[link(name = "user32")]
        extern "system" {
            fn RegisterClassW(lp_wnd_class: *const WndClassW) -> u16;
            fn CreateWindowExW(
                dw_ex_style: u32,
                lp_class_name: *const u16,
                lp_window_name: *const u16,
                dw_style: u32,
                x: i32,
                y: i32,
                n_width: i32,
                n_height: i32,
                h_wnd_parent: isize,
                h_menu: isize,
                h_instance: isize,
                lp_param: *mut core::ffi::c_void,
            ) -> isize;
            fn DefWindowProcW(h_wnd: isize, msg: u32, w_param: usize, l_param: isize) -> isize;
            fn GetMessageW(
                lp_msg: *mut Msg,
                h_wnd: isize,
                w_msg_filter_min: u32,
                w_msg_filter_max: u32,
            ) -> i32;
            fn DispatchMessageW(lp_msg: *const Msg) -> isize;
        }
        // 窗口类名：加一个产品专属前缀，避免与别人的类撞。
        let class: Vec<u16> = "lobox-end-session-guard\0".encode_utf16().collect();
        // ⚠️ `CreateWindowExW` 的 lpClassName 必须是**已注册的类**或预定义类名。
        //    直接传一个未注册的自定义名 ⇒ CreateWindowExW 返回 0（类找不到）
        //    ⇒ 守卫静默不生效（而我们只会记一条 warn，很容易被忽略）。
        //    ⇒ 必须先 RegisterClassW。WNDCLASS 的 lpfnWndProc 置 null ⇒
        //      Windows 用 DefWindowProc 兜底 ⇒ 而 WM_QUERYENDSESSION 由本函数
        //      的消息循环自己判，不经 WndProc ⇒ 所以不需要自定义 WndProc。
        let wc = WndClassW {
            style: 0,
            lpfn_wnd_proc: Some(minimal_wnd_proc),
            cb_cls_extra: 0,
            cb_wnd_extra: 0,
            h_instance: 0,
            h_icon: 0,
            h_cursor: 0,
            hbr_background: 0,
            lpsz_menu_name: core::ptr::null(),
            lpsz_class_name: class.as_ptr(),
        };
        if RegisterClassW(&wc) == 0 {
            return false;
        }
        let hwnd = CreateWindowExW(
            0,
            class.as_ptr(),
            class.as_ptr(),
            0,       // 无样式（message-only 不需要 WS_ 样式）
            0,
            0,
            0,
            0,
            HWND_MESSAGE,
            0,
            0,
            core::ptr::null_mut(),
        );
        if hwnd == 0 {
            return false;
        }
        let _ = END_SESSION_HWND.set(hwnd);
        // 消息循环：本线程（调用方所在线程）跑。注意 GetMessageW 阻塞 ⇒
        // **必须在专用线程里跑**，否则会卡住调用方（见 main.rs 的调用点）。
        loop {
            let mut msg: Msg = core::mem::zeroed();
            let r = GetMessageW(&mut msg, hwnd, 0, 0);
            if r == 0 || r == -1 {
                break; // WM_QUIT 或错误
            }
            if msg.message == WM_QUERYENDSESSION {
                // 先放行（Windows 只给 5 秒，见下），再跑停机。
                DefWindowProcW(msg.hwnd, WM_QUERYENDSESSION, 1, ENDSESSION_CLOSEAPP as isize);
                if let Some(f) = END_SESSION_HOOK.get() {
                    f();
                }
                continue;
            }
            DispatchMessageW(&msg);
        }
        true
    }
}

/// Win32 `MSG`（x64，逐字段照 MSDN，**字段序不能改**）：
/// `hwnd(8) message(4) [pad4] wParam(8) lParam(8) time(4) pt_x(4) pt_y(4) [pad4]` = 48 字节。
///
/// ⚠️ 这里栽过一次：第一版按「我以为的顺序」写成
///   `hwnd, message, _pad, time, pt_x, pt_y, l_param`（36 字节，**漏了 `wParam`**）
/// ⇒ `GetMessageW` 按真实布局写 40+ 字节 ⇒ **栈缓冲区溢出**（Rust 的 `zeroed()`
///   在栈上，而 `#[repr(C)]` 只保证字段序与各自对齐，**不保证与 Win32 语义对应**）。
/// ⇒ 手写 Win32 结构体必须逐字段对 MSDN，不能凭印象。
#[cfg(windows)]
#[repr(C)]
struct Msg {
    hwnd: isize,
    message: u32,
    _pad0: u32, // message(4) → wParam(8) 的对齐填充
    w_param: usize,
    l_param: isize,
    time: u32,
    pt_x: i32,
    pt_y: i32,
    _pad1: u32, // pt_y(4) → 结构末尾 8 字节对齐
}

/// Win32 `WNDCLASSW`（`RegisterClassW` 入参）。
///
/// ⚠️ `lpfn_wnd_proc` **必须非 null**：MSDN 的 `WNDCLASS::lpfnWndProc` 类型是
///    `WNDPROC`（非 Optional）⇒ 置 null 很可能让 `RegisterClassW` 返 0
///    ⇒ message-only 窗口建不出来 ⇒ 守卫静默不生效。
///    ⇒ 所以传真 WndProc（哪怕它只做 `DefWindowProcW` 转发）——本实现不需要
///      自定义消息处理（`WM_QUERYENDSESSION` 由 `install_end_session_guard` 的
///      消息循环自己判），但必须给一个合法的函数指针。
#[cfg(windows)]
#[repr(C)]
struct WndClassW {
    style: u32,
    lpfn_wnd_proc: Option<unsafe extern "system" fn(isize, u32, usize, isize) -> isize>,
    cb_cls_extra: i32,
    cb_wnd_extra: i32,
    h_instance: isize,
    h_icon: isize,
    h_cursor: isize,
    hbr_background: isize,
    lpsz_menu_name: *const u16,
    lpsz_class_name: *const u16,
}

/// 最小 WndProc：全部转 `DefWindowProcW`。
///
/// 之所以还需要它：`WNDCLASS::lpfnWndProc` 非 Optional（见 `WndClassW` 的注释）。
/// 之所以能这么小：`WM_QUERYENDSESSION` 不在 WndProc 里处理——它在
/// `install_end_session_guard` 的消息循环里被判（那条路径先 `DefWindowProcW`
/// 放行，再跑停机回调）。
#[cfg(windows)]
unsafe extern "system" fn minimal_wnd_proc(
    hwnd: isize,
    msg: u32,
    w_param: usize,
    l_param: isize,
) -> isize {
    #[link(name = "user32")]
    extern "system" {
        fn DefWindowProcW(h_wnd: isize, msg: u32, w_param: usize, l_param: isize) -> isize;
    }
    DefWindowProcW(hwnd, msg, w_param, l_param)
}

/// 非 Windows：会话结束走 SIGTERM（真信号）⇒ 由 `RunEvent::ExitRequested`
/// 与 `app.exit()` 那条已推的路径覆盖 ⇒ 这里无操作。
#[cfg(not(windows))]
pub fn install_end_session_guard(_on_session_ending: fn()) -> bool {
    false
}

// ─────────────────────────────────────────────────────────────────────────────
// 件 A：壳 → 内核的「父死子死」绑定（Windows JobObject）
//
// 用户裁决（2026-10-16）：**壳进程一退，内核 + DSH + frpc + router/lan + 沙箱全停。**
// 理由：lobox 是「Agent 的跨平台管理面板」，DSH 是它监管的产品；壳关了 = 面板不跑
// = 它监管的一切都该停。这也落在「壳自己有一套完整的进程管理器，负责内核向下所有
// 编排进程的统一管理」上。
//
// 为什么需要这一层（而不是靠 shutdown_all）：
//   `shutdown_all`（guardctl.rs）只在壳**主动退出**时跑。壳被 kill -9 / 强杀 /
//   崩溃时它根本不执行 ⇒ 内核继续活着。那不是「洞」，是 `shutdown_all` 结构上
//   覆盖不到的一层 —— 故这是**新建**而非补洞，如实记。
//
// 语义已由一次性探针验证（2026-10-16，PowerShell 调同套 API）：
//   · `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` + assign ⇒ 关闭 job handle 时 job 内
//     全部进程被杀。**方向 1 PASS**。
//   · `JOB_OBJECT_LIMIT_BREAKAWAY_OK` + 子进程带 `CREATE_BREAKAWAY_FROM_JOB`
//     ⇒ 该后代逃出 job、job 关闭时不被杀。**方向 2 未验证**（PowerShell 探针
//     无法可靠构造「父在 job 内」的场景），标记为 UNVERIFIED，不当成 PASS。
//
// ⚠ job handle 的生命周期是设计关键，不是疏漏：
//   `KILL_ON_JOB_CLOSE` 在**最后一个 handle 关闭**时触发。若 assign 完就
//   CloseHandle，job 立刻销毁 ⇒ 内核被立即杀（或 job 失效，取决于时序）。
//   ⇒ 故 handle 存进进程级 static 且**永不主动关闭**，让壳进程退出时操作系统
//     代我们关闭。这是刻意的「泄漏」：壳活一天 handle 活一天；壳一退，
//     handle 关闭 ⇒ 全链杀。
//   ⇒ 后人若把它当资源泄漏「修掉」（加 CloseHandle），效果会**立刻反转**成
//     「拉起内核即杀内核」。这与 guard.lock 的教训互补：那个是该关的没关
//     （锁脱钩），这个是**不能关的关了会触发相反效果**。
//
// 与 `bounded::pid_alive` 同文件同范式（`#[link]` 贴 extern 块上）。
// ─────────────────────────────────────────────────────────────────────────────

/// `JOBOBJECT_BASIC_LIMIT_INFORMATION`（Win32 结构，布局必须与 C 一致）。
/// 字段序序与类型照 MSDN；`ULONG_PTR`/`SIZE_T` 在 x64 上为 8 字节。
#[cfg(windows)]
#[repr(C)]
struct JobObjectBasicLimitInformation {
    per_process_user_time_limit: i64,
    per_job_user_time_limit: i64,
    limit_flags: u32,
    minimum_working_set_size: usize,
    maximum_working_set_size: usize,
    active_process_limit: u32,
    affinity: usize,
    priority_class: u32,
    scheduling_class: u32,
}

/// `IO_COUNTERS`（6 × ULONG64）。
#[cfg(windows)]
#[repr(C)]
struct IoCounters {
    read_operations: u64,
    write_operations: u64,
    other_operations: u64,
    read_transfer: u64,
    write_transfer: u64,
    other_transfer: u64,
}

/// `JOBOBJECT_EXTENDED_LIMIT_INFORMATION`。
/// 探针实测 `sizeof == 144`（x64）—— 与下面 `EXTENDED_LEN` 的推导一致。
#[cfg(windows)]
#[repr(C)]
struct JobObjectExtendedLimitInformation {
    basic: JobObjectBasicLimitInformation,
    io: IoCounters,
    process_memory_limit: usize,
    job_memory_limit: usize,
    peak_process_memory_used: usize,
    peak_job_memory_used: usize,
}

#[cfg(windows)]
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: u32 = 0x0000_2000;
#[cfg(windows)]
const JOB_OBJECT_LIMIT_BREAKAWAY_OK: u32 = 0x0000_0800;
/// `JobObjectExtendedLimitInformation` 信息类。
#[cfg(windows)]
const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION: u32 = 9;

/// 进程级 job handle（**存 `usize` 而不是 `*mut c_void`**）。
///
/// 为什么：`static` 要求类型 `Sync`，而裸指针 `*mut c_void` 既非 `Send` 也非
/// `Sync` ⇒ 编译报 `cannot be shared between threads`（E0308 家族）。
/// 存 `usize`（`Send + Sync`）编译过，且 handle 的值跨线程不变（它只是个整数
/// 标识），用时再 `as *mut c_void` 转回。
/// `None` = 还没建（尚未 spawn 过内核）。
/// 刻意不提供 `close()`：见上面「生命周期是设计关键」。
#[cfg(windows)]
static KILL_ON_CLOSE_JOB: std::sync::OnceLock<usize> = std::sync::OnceLock::new();

/// 确保「壳退即全杀」的 job 已建成；返回其 handle。
///
/// 幂等：同一个壳进程内反复调用复用同一个 job（`OnceLock`）。
/// 返回 `None` = 建失败（`CreateJobObjectW` 或 `SetInformationJobObject` 失败）——
/// 调用方必须把它当「壳自身缺陷」处理（`/pm/keep-alive` 返 500 + error），
/// 不能当成「assign 失败」而静默。
///
/// ⚠️ job handle 刻意**不主动关闭**：`KILL_ON_JOB_CLOSE` 在最后一个 handle
///    关闭时触发。若 assign 完就 `CloseHandle`，job 立刻销毁 ⇒ 内核被立即杀
///    （或 job 失效）。⇒ handle 与壳进程同寿，让壳退出时操作系统代我们关闭。
///    后人若把它当资源泄漏「修掉」（加 CloseHandle），效果会**立刻反转**成
///    「拉起内核即杀内核」。这与 `guard.lock` 的教训互补：那个是该关的没关
///    （锁脱钩），这个是**不能关的关了会触发相反效果**。
#[cfg(windows)]
pub fn ensure_kill_on_close_job() -> Option<usize> {
    use std::sync::OnceLock;
    static INIT: OnceLock<()> = OnceLock::new();
    INIT.get_or_init(|| unsafe {
        // #[link] 必须贴在 extern 块上（块属性），不能挂语句位 —— bounded.rs:100-102
        // 记的是同一个坑：挂外面会被解析为块后的一条表达式，链接信息丢失。
        #[link(name = "kernel32")]
        extern "system" {
            fn CreateJobObjectW(
                lp_job_attributes: *mut core::ffi::c_void,
                lp_name: *const u16,
            ) -> *mut core::ffi::c_void;
            fn SetInformationJobObject(
                h_job: *mut core::ffi::c_void,
                job_object_information_class: u32,
                lp_job_object_information: *mut core::ffi::c_void,
                cb_job_object_information_length: u32,
            ) -> i32;
        }
        let job = CreateJobObjectW(core::ptr::null_mut(), core::ptr::null());
        if job.is_null() {
            return;
        }
        // 两个 flag 都要：
        //   KILL_ON_JOB_CLOSE ⇒ 壳退全杀（本次目标）；
        //   BREAKAWAY_OK     ⇒ 让内核侧能把「不该随壳死的」（用户的浏览器）与
        //                      「半份比不装更糟的」（npm install 中途）带出 job。
        //   后者是内核侧 2' 改动的前提；只置前者 ⇒ 浏览器被越界杀。
        let mut info: JobObjectExtendedLimitInformation = core::mem::zeroed();
        info.basic.limit_flags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_BREAKAWAY_OK;
        let ok = SetInformationJobObject(
            job,
            JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
            (&mut info as *mut JobObjectExtendedLimitInformation).cast(),
            core::mem::size_of::<JobObjectExtendedLimitInformation>() as u32,
        );
        if ok == 0 {
            return;
        }
        // 存 usize（static 要 Sync，裸指针不是）⇒ 用时再转回 *mut c_void。
        let _ = KILL_ON_CLOSE_JOB.set(job as usize);
    });
    KILL_ON_CLOSE_JOB.get().copied()
}

/// 把一个**已存在**的 pid assign 进「壳退即全杀」的 job。
///
/// 与 `bind_kill_on_close` 的区别：那个收 `&Child`（壳自己 spawn 的路径），
/// 这个收裸 pid（壳 API `/pm/keep-alive` 用——内核 spawn 后代后报 pid 过来）。
/// ⇒ 需自己 `OpenProcess` 拿 handle。
///
/// 返回 `false` = 没绑上（pid 非活进程 / assign 失败）。调用方据场景判：
///   · pid 非活进程 ⇒ 记 info（调用方时序问题，此时也无需 assign）；
///   · job 未建成 ⇒ 那是壳自身缺陷，须返 500 + error。
#[cfg(windows)]
pub fn assign_to_job(job: usize, pid: u32) -> bool {
    if job == 0 {
        return false;
    }
    let job = job as *mut core::ffi::c_void;
    unsafe {
        #[link(name = "kernel32")]
        extern "system" {
            fn OpenProcess(
                dw_desired_access: u32,
                b_inherit_handle: i32,
                dw_process_id: u32,
            ) -> *mut core::ffi::c_void;
            fn AssignProcessToJobObject(h_job: *mut core::ffi::c_void, h_process: *mut core::ffi::c_void) -> i32;
            fn CloseHandle(h_object: *mut core::ffi::c_void) -> i32;
        }
        // PROCESS_SET_QUOTA | PROCESS_TERMINATE —— assign 需要的最小权限。
        const PROCESS_SET_QUOTA: u32 = 0x0100;
        const PROCESS_TERMINATE: u32 = 0x0001;
        let h = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
        if h.is_null() {
            return false;
        }
        let rc = AssignProcessToJobObject(job, h);
        CloseHandle(h);
        rc != 0
    }
}

/// 把子进程绑进「壳退即全杀」的 job（壳自己 spawn 的路径）。
///
/// 返回 `false` 表示**没绑上**（子进程已退出 / job 创建失败 / assign 失败）——
/// 调用方应照常继续（子进程已退出时无需绑），只记一条 info。
/// 这不是 fail-closed 项：绑不上只意味着「这一只内核不会被父死连带」，
/// 而壳主动退出时 `shutdown_all` 仍会按 pid 杀它。
///
/// 幂等：同一个壳进程反复 spawn（healer 重拉）复用同一个 job。
#[cfg(windows)]
pub fn bind_kill_on_close(child: &mut std::process::Child) -> bool {
    let Some(job) = ensure_kill_on_close_job() else {
        return false;
    };
    // 子进程可能已经退出（竞态窗口在 spawn 与 assign 之间）⇒ assign 失败不是错误。
    let handle = std::os::windows::io::AsRawHandle::as_raw_handle(child);
    unsafe {
        #[link(name = "kernel32")]
        extern "system" {
            fn AssignProcessToJobObject(h_job: *mut core::ffi::c_void, h_process: *mut core::ffi::c_void) -> i32;
        }
        AssignProcessToJobObject(job as *mut core::ffi::c_void, handle) != 0
    }
}

/// 非 Windows：件 A 不适用（Unix 侧是件 B 的 `PR_SET_PDEATHSIG`）。
/// 返回 `false` 让调用方走同一条「没绑上」分支，不额外分支。
#[cfg(not(windows))]
pub fn bind_kill_on_close(_child: &mut std::process::Child) -> bool {
    false
}

/// 非 Windows：无 job 概念（Unix 侧是件 B 的 `PR_SET_PDEATHSIG`）。
#[cfg(not(windows))]
pub fn ensure_kill_on_close_job() -> Option<usize> {
    None
}

/// 非 Windows：无 job 概念（Unix 侧是件 B 的 `PR_SET_PDEATHSIG`）。
#[cfg(not(windows))]
pub fn assign_to_job(_job: usize, _pid: u32) -> bool {
    false
}

/// job 内当前成员数（供留痕：壳退出前记「job 里有哪些进程」）。
/// 取不到返回 `None` —— 那本身也是线索（job 没建成）。
#[cfg(windows)]
pub fn job_member_count() -> Option<u32> {
    use std::sync::OnceLock;
    static INIT: OnceLock<()> = OnceLock::new();
    INIT.get_or_init(|| unsafe {
        #[link(name = "kernel32")]
        extern "system" {
            fn QueryInformationJobObject(
                h_job: *mut core::ffi::c_void,
                job_object_information_class: u32,
                lp_job_object_information: *mut core::ffi::c_void,
                cb_job_object_information_length: u32,
                lp_return_length: *mut u32,
            ) -> i32;
        }
        // 只在这里建 job 会让「未 spawn 过内核」也返回 Some(0)；
        // 实际调用方都在 spawn 之后，故直接查已建的那个。
        let _ = QueryInformationJobObject;
    });
    let job = KILL_ON_CLOSE_JOB.get().copied()?;
    // `JOBOBJECT_BASIC_ACCOUNTING_INFORMATION` 的 `TotalProcesses` 字段。
    #[repr(C)]
    struct BasicAccounting {
        total_user_time: i64,
        total_kernel_time: i64,
        this_period_total_user_time: i64,
        this_period_total_kernel_time: i64,
        total_page_fault_count: u32,
        total_processes: u32,
        active_processes: u32,
        total_terminated_processes: u32,
    }
    let mut acc: BasicAccounting = unsafe { core::mem::zeroed() };
    let rc = unsafe {
        #[link(name = "kernel32")]
        extern "system" {
            fn QueryInformationJobObject(
                h_job: *mut core::ffi::c_void,
                job_object_information_class: u32,
                lp_job_object_information: *mut core::ffi::c_void,
                cb_job_object_information_length: u32,
                lp_return_length: *mut u32,
            ) -> i32;
        }
        QueryInformationJobObject(
            // `usize` 化的 job handle（见本文件 KILL_ON_CLOSE_JOB 的注释：static 要求
            // Sync，裸指针既非 Send 也非 Sync）⇒ 进 FFI 前转回 `*mut c_void`。
            job as *mut core::ffi::c_void,
            1, // JobObjectBasicAccountingInformation
            (&mut acc as *mut BasicAccounting).cast(),
            core::mem::size_of::<BasicAccounting>() as u32,
            core::ptr::null_mut(),
        )
    };
    if rc == 0 {
        None
    } else {
        Some(acc.active_processes)
    }
}

#[cfg(not(windows))]
pub fn job_member_count() -> Option<u32> {
    None
}

/// 终止结果的唯一判据形态。三种现场的可操作结论完全不同：已终止 / 本来就不在 /
/// 终止失败（要报错），压成一个 bool 会让「进程还在跑」被读成「已停止」。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KillOutcome {
    /// 树已被终止。
    Terminated,
    /// 目标本来就不存在——对「停机」这个目标而言是成功。
    AlreadyGone,
    /// 终止失败，调用方必须当失败处理。
    Failed,
}

impl KillOutcome {
    pub fn is_success(self) -> bool {
        matches!(self, KillOutcome::Terminated | KillOutcome::AlreadyGone)
    }
}

/// 按 pid 终止进程树（不持有 Child 句柄时用：壳从进程表登记项反查 pid 停机）。
/// 与 kill_tree 的区别仅在入口：那个收 Child（壳自己 spawn 的路径），
/// 这个收 pid（内核自报 / 上次会话遗留 / 已 detach 的进程）。
/// 判据收口到 KillOutcome：此前本函数把 run_checked 的错误串里出现 "128" 当成功
/// （而错误串恰好含退出码 128，故真会命中），platform::kill_managed_processes 又把
/// 任何非零当 Err——两处结论相反。统一按退出码判定。
pub fn kill_tree_pid(pid: u32) -> KillOutcome {
    if !pid_alive(pid) {
        return KillOutcome::AlreadyGone;
    }
    #[cfg(windows)]
    {
        // taskkill /T /F：杀整树。退出码 128 = 进程不存在（已退出）。
        let r = run(
            std::process::Command::new("taskkill")
                .arg("/PID")
                .arg(pid.to_string())
                .arg("/T")
                .arg("/F"),
            std::time::Duration::from_secs(10),
        );
        return match r {
            Ok(o) if o.success => KillOutcome::Terminated,
            Ok(o) => {
                if o.code == Some(128) {
                    KillOutcome::AlreadyGone
                } else {
                    crate::telemetry::event::warn("process.taskkill_failed", "bounded", serde_json::json!({ "pid": pid, "stderr": o.stderr.trim() }));
                    KillOutcome::Failed
                }
            }
            Err(e) => {
                crate::telemetry::event::warn("process.taskkill_error", "bounded", serde_json::json!({ "pid": pid, "error": e.to_string() }));
                KillOutcome::Failed
            }
        };
    }
    #[cfg(not(windows))]
    {
        // 先 SIGTERM 进程组，再兜底 SIGKILL 单 pid。
        let _term = std::process::Command::new("kill")
            .arg("-TERM")
            .arg("-")
            .arg(pid.to_string())
            .status();
        std::thread::sleep(std::time::Duration::from_millis(300));
        if !pid_alive(pid) {
            return KillOutcome::Terminated;
        }
        let killed = std::process::Command::new("kill")
            .arg("-KILL")
            .arg(pid.to_string())
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        if killed {
            KillOutcome::Terminated
        } else if !pid_alive(pid) {
            KillOutcome::Terminated
        } else {
            KillOutcome::Failed
        }
    }
}

pub struct Live {
    pub elapsed: Duration,
    pub lines: usize,
    pub last_line: String,
}

pub fn run_watch(
    cmd: &mut Command,
    timeout: Duration,
    heartbeat: Duration,
    on_live: &dyn Fn(&Live),
) -> Result<ExecRecord, String> {
    run_inner(cmd, timeout, Some((heartbeat, on_live)))
}

pub fn run(cmd: &mut Command, timeout: Duration) -> Result<ExecRecord, String> {
    run_inner(cmd, timeout, None)
}

fn run_inner(
    cmd: &mut Command,
    timeout: Duration,
    watch: Option<(Duration, &dyn Fn(&Live))>,
) -> Result<ExecRecord, String> {
    
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
fn read_log(p: &std::path::Path) -> String {
    match std::fs::read(p) {
        Ok(bytes) => decode_console(&bytes),
        Err(_) => String::new(),
    }
}

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
        
        assert_eq!(decode_console(b""), "");
        assert_eq!(decode_console("内核已对齐 v0.1.5".as_bytes()), "内核已对齐 v0.1.5");
        assert_eq!(decode_console(b"plain ascii"), "plain ascii");
    }

        
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
