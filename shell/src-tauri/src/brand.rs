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
/// 读 shared-constants 里的字符串数组（逗号分隔），返回静态切片。
/// 用于 core_bin_names / state.*Segments 这类「一段列表」常量——
/// shared_str 只能取标量，这些此前在 brand.rs 与 brand.js 各存一份副本。
pub fn shared_str_arr(path: &str) -> &'static [&'static str] {
    static CELL: std::sync::OnceLock<Vec<&'static str>> = std::sync::OnceLock::new();
    CELL.get_or_init(|| {
        let raw = shared_str(path);
        raw.split(',').map(|s| s.trim()).filter(|s| !s.is_empty()).collect()
    })
    .as_slice()
}



macro_rules! shared_str_cell {
    ($fn_name:ident, $path:expr) => {
        pub fn $fn_name() -> &'static str {
            static CELL: std::sync::OnceLock<&'static str> = std::sync::OnceLock::new();
            CELL.get_or_init(|| shared_str($path))
        }
    };
}

macro_rules! shared_str_arr_cell {
    ($fn_name:ident, $path:expr) => {
        pub fn $fn_name() -> &'static [&'static str] {
            shared_str_arr($path)
        }
    };
}

// R9 跨层常量收口：下列字符串常量改为读取 shared-constants.json。
// shared_str 是运行期函数（解析器依赖字符串操作），不能用于 const 初始化（E0015），
// 因此统一用 OnceLock + 访问器函数；宏为每个常量生成独立 static 与访问器。
// 单源常量访问器：把 shared_str_cell!(name, "段.键") 展开成同名无参函数。
//
// static 必须放在**函数体内**而非宏顶层：宏展开不创建新作用域，若 static 在顶层，
// 本文件 70 次展开会在同一模块产生 70 个同名 CELL → E0428 duplicate definitions。
// 放进函数体后每次展开生成独立函数，各自持有自己的 CELL，互不冲突。
/// 数组版 shared_str_cell：展开成返回 &'static [&'static str] 的无参函数。
// static 同样放在函数体内——宏展开不创建作用域，放顶层会与 shared_str_cell!
/// 的同名 CELL 冲突（且本文件多次展开自身也会冲突）。
// core 可执行名候选（四平台 core_exe_names 的唯一来源）。
shared_str_arr_cell!(core_bin_names, "platform.cliBinNames");


pub const PRODUCT_NAME: &str = "lobox";

pub const CLI_NAME: &str = "lobox";

pub const GUI_BIN_NAME: &str = "lobox-shell";

pub const GUI_CRATE_NAME: &str = "lobox-shell";


shared_str_cell!(npm_scope, "product.npmScope");
shared_str_cell!(core_pkg_prefix, "product.corePkgPrefix");
shared_str_cell!(shell_release_pkg, "product.shellReleasePkg");

shared_str_cell!(tauri_identifier, "product.tauriIdentifier");
shared_str_cell!(tauri_product_name, "product.tauriProductName");

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

shared_str_arr_cell!(state_root_win_base_fallback_segments, "state.winFallbackSegments");

shared_str_arr_cell!(state_root_macos_segments, "state.macosSegments");

static STATE_ROOT_LINUX_XDG_ENV_CELL: std::sync::OnceLock<&'static str> = std::sync::OnceLock::new();

// 真相来自 shared-constants.json。不能用 const：解析器依赖运行期字符串操作。
pub fn state_root_linux_xdg_env() -> &'static str {
    STATE_ROOT_LINUX_XDG_ENV_CELL.get_or_init(|| shared_str("state.linuxXdgEnv"))
}

shared_str_arr_cell!(state_root_linux_fallback_segments, "state.linuxFallbackSegments");

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

shared_str_cell!(env_config, "env.config");
shared_str_cell!(env_daemon, "env.daemon");
shared_str_cell!(env_tray_port, "env.tray_port");
shared_str_cell!(env_shell_exe, "env.shell_exe");
shared_str_cell!(env_guard_bin, "env.guard_bin");
shared_str_cell!(env_harness_bin, "env.harness_bin");
shared_str_cell!(env_smoke_pid, "env.smoke_pid");
shared_str_cell!(env_canary, "env.canary");
shared_str_cell!(env_canary_id, "env.canary_id");
shared_str_cell!(env_canary_allowlist, "env.canary_allowlist");
shared_str_cell!(env_deploy_form, "env.deploy_form");
shared_str_cell!(env_ui_dir, "env.ui_dir");
shared_str_cell!(env_ui_skip_install, "env.ui_skip_install");
shared_str_cell!(env_core_scope, "env.core_scope");
shared_str_cell!(env_publish_registry, "env.publish_registry");
shared_str_cell!(env_npm_provenance, "env.npm_provenance");
shared_str_cell!(env_npmrc, "env.npmrc");
shared_str_cell!(env_npm_auth_prev, "env.npm_auth_prev");
shared_str_cell!(env_npm_auth_prev_set, "env.npm_auth_prev_set");
shared_str_cell!(env_npm_auth_prevl, "env.npm_auth_prevl");
shared_str_cell!(env_npm_auth_prevl_set, "env.npm_auth_prevl_set");
shared_str_cell!(env_npm_auth_source, "env.npm_auth_source");
shared_str_cell!(env_npm_auth_tmp, "env.npm_auth_tmp");
shared_str_cell!(env_cred_dir, "env.cred_dir");
shared_str_cell!(env_cred_allow_overwrite, "env.cred_allow_overwrite");
shared_str_cell!(env_cred_force, "env.cred_force");
shared_str_cell!(env_cred_backup_dir, "env.cred_backup_dir");
shared_str_cell!(env_real_home, "env.real_home");
shared_str_cell!(env_arch_override, "env.arch_override");
shared_str_cell!(env_platform_override, "env.platform_override");
shared_str_cell!(env_esbuild_version, "env.esbuild_version");
shared_str_cell!(env_version_lib, "env.version_lib");



shared_str_cell!(windows_gui_task, "platform.windowsGuiTask");
shared_str_cell!(windows_run_value, "platform.windowsRunValue");
shared_str_cell!(systemd_unit_name, "platform.systemdUnitName");
shared_str_cell!(systemd_unit_file, "platform.systemdUnitFile");
pub fn macos_guard_label() -> String {
    format!("{}.core", tauri_identifier())
}

pub fn macos_gui_label() -> String {
    format!("{}.shell", tauri_identifier())
}


shared_str_cell!(sea_bundle_name, "packaging.seaBundleName");
shared_str_cell!(sea_version_define, "packaging.seaVersionDefine");
shared_str_cell!(kernel_archive_template, "packaging.kernelArchiveTemplate");
shared_str_cell!(kernel_release_tarball_template, "packaging.kernelReleaseTarballTemplate");
shared_str_cell!(launcher_dir_template, "packaging.launcherDirTemplate");
shared_str_cell!(installer_nsis_win_x64_template, "packaging.installerNsisWinX64Template");
shared_str_cell!(installer_macos_app_template, "packaging.installerMacosAppTemplate");
shared_str_cell!(installer_deb_linux_x64_template, "packaging.installerDebLinuxX64Template");
shared_str_cell!(installer_dmg_arm64_template, "packaging.installerDmgArm64Template");
shared_str_cell!(installer_dmg_x64_template, "packaging.installerDmgX64Template");


static PROC_MATCH_GUARD_CELL: std::sync::OnceLock<&'static str> = std::sync::OnceLock::new();

// 真相来自 shared-constants.json。不能用 const：解析器依赖运行期字符串操作。
pub fn proc_match_guard() -> &'static str {
    PROC_MATCH_GUARD_CELL.get_or_init(|| shared_str("proc.matchGuard"))
}

shared_str_cell!(proc_match_gui, "proc.matchGui");
shared_str_cell!(proc_match_gui_re, "proc.matchGuiRe");



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

shared_str_cell!(store_key_api_access, "store.keyApiAccess");
shared_str_cell!(cookie_lan_token, "store.cookieLanToken");

shared_str_cell!(event_harness_exited, "event.harness_exited");
shared_str_cell!(event_harness_token_captured, "event.harness_token_captured");
shared_str_cell!(event_harness_token_missing, "event.harness_token_missing");
shared_str_cell!(event_harness_command_missing, "event.harness_command_missing");
shared_str_cell!(event_harness_not_installed, "event.harness_not_installed");
shared_str_cell!(event_harness_command_bound, "event.harness_command_bound");
shared_str_cell!(event_harness_guardian_changed, "event.harness_guardian_changed");
shared_str_cell!(event_harness_remote_changed, "event.harness_remote_changed");
shared_str_cell!(event_harness_remote_token_changed, "event.harness_remote_token_changed");
shared_str_cell!(event_lan_harness_token_updated, "event.lan_harness_token_updated");
shared_str_cell!(event_upgrade_stopping_harness, "event.upgrade_stopping_harness");
shared_str_cell!(event_shell_update_pending, "event.shell_update_pending");
shared_str_cell!(event_shell_update_checked, "event.shell_update_checked");
shared_str_cell!(event_shell_restart_requested, "event.shell_restart_requested");

shared_str_cell!(systemd_template_aside_suffix, "platform.systemdTemplateAsideSuffix");

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
        .unwrap_or_else(|| home_join(home, state_root_win_base_fallback_segments()));
    base.join(state_dir_name())
}


pub fn state_root_macos(home: &Path) -> PathBuf {
    home_join(home, state_root_macos_segments()).join(state_dir_name())
}


pub fn state_root_linux(xdg_state_home: Option<std::ffi::OsString>, home: &Path) -> PathBuf {
    let base = env_base_os(xdg_state_home)
        .map(PathBuf::from)
        .unwrap_or_else(|| home_join(home, state_root_linux_fallback_segments()));
    base.join(state_dir_name())
}