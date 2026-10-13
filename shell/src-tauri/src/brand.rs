#![allow(dead_code)]


use std::path::{Path, PathBuf};


const SHARED_JSON: &str = include_str!("../../../shared/shared-constants.json");


// 路径段既可以是对象键，也可以是数组下标（如 "net.deprecatedApiPorts.0"）。
// 数组元素没有 "key": 形态，按下标在第 N 个元素处定位。
fn advance<'a>(cur: &'a str, part: &str, path: &str) -> &'a str {
    if let Ok(idx) = part.parse::<usize>() {
        // 先推进到数组值本身（上一段给出的形如 "[36360, 37000]"），
        // 再按下标取元素。注意剥掉左括号，否则元素文本会以 "[" 开头。
        let arr = if cur.trim_start().starts_with('[') {
            cur.trim_start()
        } else {
            let at = cur.find('[').unwrap_or_else(|| panic!("brand: 共享常量非数组 {}", path));
            &cur[at..]
        };
        let body = &arr[1..];
        let mut seg = body.trim_start();
        for _ in 0..idx {
            let end = seg.find(',').unwrap_or_else(|| panic!("brand: 共享常量数组下标越界 {}", path));
            seg = seg[end + 1..].trim_start();
        }
        return seg;
    }
    let key = format!("\"{}\"", part);
    let at = cur.find(&key).unwrap_or_else(|| panic!("brand: 共享常量缺键 {}", path));
    let rest = &cur[at + key.len()..];
    let colon = rest.find(':').unwrap_or_else(|| panic!("brand: 共享常量格式错误 {}", path));
    rest[colon + 1..].trim_start()
}

pub fn shared_str(path: &str) -> &'static str {
    let mut cur = SHARED_JSON;
    for part in path.split('.') {
        let val = advance(cur, part, path);
        if val.starts_with('{') {
            cur = val;
            continue;
        }
        let Some(a) = val.find('"') else { panic!("brand: 共享常量非字符串 {}", path) };
        let rest2 = &val[a + 1..];
        let Some(b) = rest2.find('"') else { panic!("brand: 共享常量字符串未闭合 {}", path) };
        return &rest2[..b];
    }
    panic!("brand: 共享常量路径指向对象 {}", path)
}

pub fn shared_num(path: &str) -> u16 {
    let mut cur = SHARED_JSON;
    for part in path.split('.') {
        let val = advance(cur, part, path);
        // 中间段可能是对象或数组，两者都要能继续下钻。
        if val.starts_with('{') || val.starts_with('[') {
            cur = val;
            continue;
        }
        let end = val.find(|c: char| c == ',' || c == '}' || c == ']').unwrap_or(val.len());
        let raw = val[..end].trim();
        return raw
            .parse()
            .unwrap_or_else(|_| panic!("brand: 共享常量非数字 {} = {}", path, raw));
    }
    panic!("brand: 共享常量路径指向对象 {}", path)
}

pub const PRODUCT_NAME: &str = "lobox";

pub const CLI_NAME: &str = "lobox";

pub const GUI_BIN_NAME: &str = "lobox-shell";

pub const GUI_CRATE_NAME: &str = "lobox-shell";


pub const NPM_SCOPE: &str = "@lob-ox";

pub const CORE_PKG_PREFIX: &str = "core-";

pub const SHELL_RELEASE_PKG: &str = "@lob-ox/shell-release";


pub const TAURI_IDENTIFIER: &str = "dev.bowen.lobox";

pub const TAURI_PRODUCT_NAME: &str = "lobox";


static STATE_DIR_NAME_CELL: std::sync::OnceLock<&'static str> = std::sync::OnceLock::new();

// 真相来自 shared-constants.json。不能用 const：解析器依赖运行期字符串操作。
pub fn state_dir_name() -> &'static str {
    STATE_DIR_NAME_CELL.get_or_init(|| shared_str("state.dirName"))
}

pub const STATE_SUPERVISOR_SUBDIR: &str = "supervisor";

pub const STATE_SHELL_SUBDIR: &str = "shell";

pub const LEGACY_PRODUCT_NAME: &str = "dsh-supervisor";

static STATE_ROOT_WIN_BASE_ENV_CELL: std::sync::OnceLock<&'static str> = std::sync::OnceLock::new();

// 真相来自 shared-constants.json。不能用 const：解析器依赖运行期字符串操作。
pub fn state_root_win_base_env() -> &'static str {
    STATE_ROOT_WIN_BASE_ENV_CELL.get_or_init(|| shared_str("state.winBaseEnv"))
}

pub const STATE_ROOT_WIN_BASE_FALLBACK_SEGMENTS: &[&str] = &["AppData", "Local"];

pub const STATE_ROOT_MACOS_SEGMENTS: &[&str] = &["Library", "Application Support"];

static STATE_ROOT_LINUX_XDG_ENV_CELL: std::sync::OnceLock<&'static str> = std::sync::OnceLock::new();

// 真相来自 shared-constants.json。不能用 const：解析器依赖运行期字符串操作。
pub fn state_root_linux_xdg_env() -> &'static str {
    STATE_ROOT_LINUX_XDG_ENV_CELL.get_or_init(|| shared_str("state.linuxXdgEnv"))
}

pub const STATE_ROOT_LINUX_FALLBACK_SEGMENTS: &[&str] = &[".local", "state"];

static LEGACY_HARNESS_DIR_CELL: std::sync::OnceLock<&'static str> = std::sync::OnceLock::new();

// 真相来自 shared-constants.json。不能用 const：解析器依赖运行期字符串操作。
pub fn legacy_harness_dir() -> &'static str {
    LEGACY_HARNESS_DIR_CELL.get_or_init(|| shared_str("state.legacyHarnessDir"))
}


static ENV_STATE_ROOT_CELL: std::sync::OnceLock<&'static str> = std::sync::OnceLock::new();

// 真相来自 shared-constants.json。不能用 const：解析器依赖运行期字符串操作。
pub fn env_state_root() -> &'static str {
    ENV_STATE_ROOT_CELL.get_or_init(|| shared_str("env.stateRoot"))
}

pub const ENV_CONFIG: &str = "DSH_SUPERVISOR_CONFIG";

pub const ENV_DAEMON: &str = "DSH_SUPERVISOR_DAEMON";

pub const ENV_TRAY_PORT: &str = "DSH_SUPERVISOR_TRAY_PORT";

pub const ENV_SHELL_EXE: &str = "DSH_SHELL_EXE";

pub const ENV_GUARD_BIN: &str = "DSH_GUARD_BIN";

pub const ENV_HARNESS_BIN: &str = "DSH_BIN";

pub const ENV_SMOKE_PID: &str = "DSH_PID";

pub const ENV_CANARY: &str = "DSH_CANARY";

pub const ENV_CANARY_ID: &str = "DSH_CANARY_ID";

pub const ENV_CANARY_ALLOWLIST: &str = "DSH_CANARY_ALLOWLIST";

pub const ENV_DEPLOY_FORM: &str = "DSH_DEPLOY_FORM";

pub const ENV_UI_DIR: &str = "DSH_UI_DIR";

pub const ENV_UI_SKIP_INSTALL: &str = "DSH_UI_SKIP_INSTALL";

pub const ENV_CORE_SCOPE: &str = "DSH_CORE_SCOPE";

pub const ENV_PUBLISH_REGISTRY: &str = "DSH_PUBLISH_REGISTRY";

pub const ENV_NPM_PROVENANCE: &str = "DSH_NPM_PROVENANCE";

pub const ENV_NPMRC: &str = "DSH_NPMRC";

pub const ENV_NPM_AUTH_PREV: &str = "DSH_NPM_AUTH_PREV";

pub const ENV_NPM_AUTH_PREV_SET: &str = "DSH_NPM_AUTH_PREV_SET";

pub const ENV_NPM_AUTH_PREVL: &str = "DSH_NPM_AUTH_PREVL";

pub const ENV_NPM_AUTH_PREVL_SET: &str = "DSH_NPM_AUTH_PREVL_SET";

pub const ENV_NPM_AUTH_SOURCE: &str = "DSH_NPM_AUTH_SOURCE";

pub const ENV_NPM_AUTH_TMP: &str = "DSH_NPM_AUTH_TMP";

pub const ENV_CRED_DIR: &str = "DSH_CRED_DIR";

pub const ENV_CRED_ALLOW_OVERWRITE: &str = "DSH_CRED_ALLOW_OVERWRITE";

pub const ENV_CRED_FORCE: &str = "DSH_CRED_FORCE";

pub const ENV_CRED_BACKUP_DIR: &str = "DSH_CRED_BACKUP_DIR";

pub const ENV_REAL_HOME: &str = "DSH_REAL_HOME";

pub const ENV_ARCH_OVERRIDE: &str = "DSH_ARCH_OVERRIDE";

pub const ENV_PLATFORM_OVERRIDE: &str = "DSH_PLATFORM_OVERRIDE";

pub const ENV_ESBUILD_VERSION: &str = "DSH_ESBUILD_VERSION";

pub const ENV_VERSION_LIB: &str = "DSH_VERSION_LIB";




pub const WINDOWS_GUI_TASK: &str = "Lobox-Shell";

pub const WINDOWS_RUN_VALUE: &str = "Lobox";

pub const SYSTEMD_UNIT_NAME: &str = "lobox";

pub const SYSTEMD_UNIT_FILE: &str = "lobox.service";

pub fn macos_guard_label() -> String {
    format!("{}.core", TAURI_IDENTIFIER)
}

pub fn macos_gui_label() -> String {
    format!("{}.shell", TAURI_IDENTIFIER)
}


pub const SEA_BUNDLE_NAME: &str = "core.cjs";

pub const SEA_VERSION_DEFINE: &str = "__DSH_VERSION__";

pub const KERNEL_ARCHIVE_TEMPLATE: &str = "lobox-{ver}.tar.gz";

pub const KERNEL_RELEASE_TARBALL_TEMPLATE: &str = "lobox-kernel-{ver}-{plat}.tar.gz";

pub const LAUNCHER_DIR_TEMPLATE: &str = "lobox-{ver}-{plat}-{arch}";

pub const INSTALLER_NSIS_WIN_X64_TEMPLATE: &str = "{product}_{ver}_x64-setup.exe";

pub const INSTALLER_MACOS_APP_TEMPLATE: &str = "{product}.app.tar.gz";

pub const INSTALLER_DEB_LINUX_X64_TEMPLATE: &str = "{product}_{ver}_amd64.deb";

pub const INSTALLER_DMG_ARM64_TEMPLATE: &str = "{product}_{ver}_aarch64.dmg";

pub const INSTALLER_DMG_X64_TEMPLATE: &str = "{product}_{ver}_x64.dmg";

pub const CLI_BIN_NAMES: &[&str] = &["lobox.exe", "lobox.cmd", "lobox"];

pub const CLI_SHIM_NAMES: &[&str] = &["lobox", "lobox.cmd", "lobox.ps1"];

pub const GUI_BIN_NAMES: &[&str] = &["lobox-shell", "lobox-shell.exe"];


static PROC_MATCH_GUARD_CELL: std::sync::OnceLock<&'static str> = std::sync::OnceLock::new();

// 真相来自 shared-constants.json。不能用 const：解析器依赖运行期字符串操作。
pub fn proc_match_guard() -> &'static str {
    PROC_MATCH_GUARD_CELL.get_or_init(|| shared_str("proc.matchGuard"))
}

pub const PROC_MATCH_GUI: &str = "lobox-shell";

pub const PROC_MATCH_GUI_RE: &str = "lobox-shell(\\.exe)?";




// R8：postMessage 消息名从 shared-constants.json 的 bridge 段读，与 Node 侧
// kernelUpdateBridge.ts 同源。此前两侧各硬编码一份，改消息名时三处不会同时变。
// shared_str 是运行期函数（解析器依赖字符串操作），故用 OnceLock 懒初始化。
static BRIDGE_MSG_REQUEST_CELL: std::sync::OnceLock<&'static str> = std::sync::OnceLock::new();
static BRIDGE_MSG_RESULT_CELL: std::sync::OnceLock<&'static str> = std::sync::OnceLock::new();
static BRIDGE_MSG_PROGRESS_CELL: std::sync::OnceLock<&'static str> = std::sync::OnceLock::new();

pub fn bridge_msg_kernel_update_request() -> &'static str {
    BRIDGE_MSG_REQUEST_CELL.get_or_init(|| shared_str("bridge.msgKernelUpdateRequest"))
}

pub fn bridge_msg_kernel_update_result() -> &'static str {
    BRIDGE_MSG_RESULT_CELL.get_or_init(|| shared_str("bridge.msgKernelUpdateResult"))
}

pub fn bridge_msg_kernel_update_progress() -> &'static str {
    BRIDGE_MSG_PROGRESS_CELL.get_or_init(|| shared_str("bridge.msgKernelUpdateProgress"))
}

pub const STORE_KEY_API_ACCESS: &str = "lobox.apiAccessKey";

pub const COOKIE_LAN_TOKEN: &str = "lobox_lan_token";


pub const EVENT_HARNESS_EXITED: &str = "harness_exited";

pub const EVENT_HARNESS_TOKEN_CAPTURED: &str = "harness_token_captured";

pub const EVENT_HARNESS_TOKEN_MISSING: &str = "harness_token_missing";

pub const EVENT_HARNESS_COMMAND_MISSING: &str = "harness_command_missing";

pub const EVENT_HARNESS_NOT_INSTALLED: &str = "harness_not_installed";

pub const EVENT_HARNESS_COMMAND_BOUND: &str = "harness_command_bound";

pub const EVENT_HARNESS_GUARDIAN_CHANGED: &str = "harness_guardian_changed";

pub const EVENT_HARNESS_REMOTE_CHANGED: &str = "harness_remote_changed";

pub const EVENT_HARNESS_REMOTE_TOKEN_CHANGED: &str = "harness_remote_token_changed";

pub const EVENT_LAN_HARNESS_TOKEN_UPDATED: &str = "lan_harness_token_updated";

pub const EVENT_UPGRADE_STOPPING_HARNESS: &str = "upgrade_stopping_harness";

pub const EVENT_SHELL_UPDATE_PENDING: &str = "shell_update_pending";

pub const EVENT_SHELL_UPDATE_CHECKED: &str = "shell_update_checked";

pub const EVENT_SHELL_RESTART_REQUESTED: &str = "shell_restart_requested";


pub const SYSTEMD_TEMPLATE_ASIDE_SUFFIX: &str = ".disabled-by-lobox-";


fn home_join(home: &Path, segments: &[&str]) -> PathBuf {
    segments.iter().fold(home.to_path_buf(), |p, s| p.join(*s))
}


fn env_base(value: Option<String>) -> Option<String> {
    value.map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}


fn env_base_os(value: Option<std::ffi::OsString>) -> Option<std::ffi::OsString> {
    let raw = value?;
    match raw.to_str() {
        Some(s) => env_base(Some(s.to_string())).map(std::ffi::OsString::from),
        None => {
            if env_base(Some(raw.to_string_lossy().to_string())).is_some() {
                Some(raw)
            } else {
                None
            }
        }
    }
}


pub fn state_root_windows(local_appdata: Option<String>, home: &Path) -> PathBuf {
    let base = env_base(local_appdata)
        .map(PathBuf::from)
        .unwrap_or_else(|| home_join(home, STATE_ROOT_WIN_BASE_FALLBACK_SEGMENTS));
    base.join(state_dir_name())
}


pub fn state_root_macos(home: &Path) -> PathBuf {
    home_join(home, STATE_ROOT_MACOS_SEGMENTS).join(state_dir_name())
}


pub fn state_root_linux(xdg_state_home: Option<std::ffi::OsString>, home: &Path) -> PathBuf {
    let base = env_base_os(xdg_state_home)
        .map(PathBuf::from)
        .unwrap_or_else(|| home_join(home, STATE_ROOT_LINUX_FALLBACK_SEGMENTS));
    base.join(state_dir_name())
}
