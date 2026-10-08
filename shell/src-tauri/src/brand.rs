#![allow(dead_code)]
// 品牌与命名的跨语言单源：与 `core/src/shared/brand.js` 声明同一组常量名。
//
// 决策 D4（X1）：跨边界常量改为**单一数据文件** `shared/shared-constants.json`，
// 本模块通过 `include_str!` 在**编译期**嵌入并解析，Node 侧运行时读取同一文件。
// 第二份副本不存在 ⇒ 不可能漂移（结构性消除，而非靠 brand-single-source-test 事后对账）。
// 范式取自 core.rs 已用的 version-vectors.json（本仓已验证的跨语言单源先例）。
//
// 仅**跨边界**的常量（Rust 侧实际引用的 11 项 + 网络/运行时共享项）从数据文件取；
// 其余只在 Rust 内部使用的名字仍以 const 声明（它们没有第二份副本，不存在漂移问题）。

use std::path::{Path, PathBuf};

// ── 跨语言共享常量（编译期从数据文件嵌入）─────────────────────────────────────
const SHARED_JSON: &str = include_str!("../../../shared/shared-constants.json");

/// 极简 JSON 取值：只取本模块需要的扁平键（形如 "product.name"）。
/// 刻意不引入 serde 依赖：这个文件结构稳定、键少，手写查找足够且零成本。
fn shared_str(path: &str) -> &'static str {
    let mut cur = SHARED_JSON;
    for part in path.split('.') {
        let key = format!("\"{}\"", part);
        let Some(at) = cur.find(&key) else { panic!("brand: 共享常量缺键 {}", path) };
        let rest = &cur[at + key.len()..];
        let Some(colon) = rest.find(':') else { panic!("brand: 共享常量格式错误 {}", path) };
        let val = rest[colon + 1..].trim_start();
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

fn shared_num(path: &str) -> u16 {
    let mut cur = SHARED_JSON;
    for (i, part) in path.split('.').enumerate() {
        let key = format!("\"{}\"", part);
        let Some(at) = cur.find(&key) else { panic!("brand: 共享常量缺键 {}", path) };
        let rest = &cur[at + key.len()..];
        let Some(colon) = rest.find(':') else { panic!("brand: 共享常量格式错误 {}", path) };
        let val = rest[colon + 1..].trim_start();
        if val.starts_with('{') { cur = val; continue; }
        let end = val.find(|c: char| c == ',' || c == '}' || c == ']').unwrap_or(val.len());
        let raw = val[..end].trim();
        let n: u16 = raw.parse().unwrap_or_else(|_| panic!("brand: 共享常量非数字 {} = {}", path, raw));
        if i == path.split('.').count() - 1 { return n; }
        return n;
    }
    panic!("brand: 共享常量路径无效 {}", path)
}

// ── 产品与组件名 ─────────────────────────────────────────────────────────────
/// 产品名：状态根/落点路径/安装目录/通知与 UA 等处的产品标识。
pub const PRODUCT_NAME: &str = shared_str("product.name");
/// 内核 CLI 可执行名：core/package.json#bin 的键与值、core/bin/lobox 安装期建立的入口名、壳定位内核的候选名。
pub const CLI_NAME: &str = shared_str("product.cliName");
/// 桌面壳可执行名（= Cargo 产物名）：壳自定位、内核识别壳进程、CI 冒烟三处共用的入口名。
pub const GUI_BIN_NAME: &str = shared_str("product.guiBinName");
/// 桌面壳 crate 名：shell/src-tauri/Cargo.toml#package.name，同时是 shell/scripts/bump-shell.sh 的 sed 锚点。
pub const GUI_CRATE_NAME: &str = shared_str("product.guiCrateName");

// ── npm 包 ──────────────────────────────────────────────────────────────────
/// npm scope：已发布包名的前缀（core/package.json#npmPublish.scope，已发布包不可改）。
pub const NPM_SCOPE: &str = "@lob-ox";
/// 内核平台子包名的前缀（不含 scope）：与平台标签拼接成裸包名 core-<tag>。
pub const CORE_PKG_PREFIX: &str = "core-";
/// 内核平台子包覆盖的四组平台标签：决定 core/package.json#npmPublish.packages 的四条。
pub const CORE_PKG_TAGS: &[&str] = &["linux-x64", "darwin-arm64", "darwin-x64", "win-x64"];
/// 壳更新清单包名：内核查最新壳版本、updater endpoint、壳产物组装三处共用的完整包名。
pub const SHELL_RELEASE_PKG: &str = "@lob-ox/shell-release";

// ── Tauri 应用身份与安装包名 ─────────────────────────────────────────────────
/// Tauri identifier（应用身份）：Windows 卸载项与升级谱系、macOS bundle id、应用数据目录名。
pub const TAURI_IDENTIFIER: &str = "dev.bowen.lobox";
/// Tauri productName：全部安装包文件名由它派生（nsis/msi/dmg/deb 与 .app.tar.gz）。
pub const TAURI_PRODUCT_NAME: &str = "lobox";

// ── 状态根（内核 state-root.js 与壳 env.rs 必须推出同一个根）──────────────────
/// 状态根目录名：三平台状态根的**最后一段**，Windows/macOS/Linux 共用。
pub const STATE_DIR_NAME: &str = shared_str("state.dirName");
/// 状态根下内核侧子目录名：config.json / ports.json / state.json / 日志的落点。
pub const STATE_SUPERVISOR_SUBDIR: &str = shared_str("state.supervisorSubdir");
/// 状态根下壳侧子目录名：identity.json / shell.log / guard 日志的落点。
pub const STATE_SHELL_SUBDIR: &str = shared_str("state.shellSubdir");
/// **旧产品名**（改名前的状态根末段）：Rust 侧只作为单源对偶声明（检测与告警在内核侧实现，见 state-root.js）。
pub const LEGACY_PRODUCT_NAME: &str = "dsh-supervisor";
/// Windows 状态根基座的环境变量名。
pub const STATE_ROOT_WIN_BASE_ENV: &str = shared_str("state.winBaseEnv");
/// 基座环境变量缺失时，Windows 状态根在家目录下的相对段（拼出 <家>/AppData/Local）。
pub const STATE_ROOT_WIN_BASE_FALLBACK_SEGMENTS: &[&str] = &["AppData", "Local"];
/// macOS 状态根在家目录下的相对段（拼出 <家>/Library/Application Support）。
pub const STATE_ROOT_MACOS_SEGMENTS: &[&str] = &["Library", "Application Support"];
/// Linux 状态根基座的环境变量名（XDG 规范）。
pub const STATE_ROOT_LINUX_XDG_ENV: &str = shared_str("state.linuxXdgEnv");
/// XDG 基座缺失时，Linux 状态根在家目录下的相对段（拼出 <家>/.local/state）。
pub const STATE_ROOT_LINUX_FALLBACK_SEGMENTS: &[&str] = &[".local", "state"];
/// 旧位置（harness 数据目录）的第一段：迁移来源，绝不能被 harness 的卸载/清理一并带走。
pub const LEGACY_HARNESS_DIR: &str = shared_str("state.legacyHarnessDir");

// ── 环境变量（本产品自己的；名字与值都是现状）────────────────────────────────
/// 状态根覆盖位：三平台最先命中并绝对化；壳注入服务定义、内核据此定位，两侧必须同名。
pub const ENV_STATE_ROOT: &str = shared_str("env.stateRoot");
/// 配置文件路径覆盖位：CLI 与内核配置装载共用。
pub const ENV_CONFIG: &str = shared_str("env.config");
/// 单实例锁文件路径覆盖位：守卫与 CLI 共用。
pub const ENV_LOCK_FILE: &str = "DSH_SUPERVISOR_LOCK_FILE";
/// 内核可执行覆盖位：自启层解析可执行文件时的第一候选。
pub const ENV_DAEMON: &str = "DSH_SUPERVISOR_DAEMON";
/// 托盘端口覆盖位：壳读它决定托盘桥端口。
pub const ENV_TRAY_PORT: &str = "DSH_SUPERVISOR_TRAY_PORT";
/// 壳可执行覆盖位：自启层解析壳可执行文件时的第一候选。
pub const ENV_SHELL_EXE: &str = "DSH_SHELL_EXE";
/// 守卫可执行覆盖位：壳的服务定义自检与 CI 冒烟用来注入占位文件。
pub const ENV_GUARD_BIN: &str = "DSH_GUARD_BIN";
/// 被监管 harness 可执行覆盖位：内核解析 dsh 入口时优先读它。
pub const ENV_HARNESS_BIN: &str = "DSH_BIN";
/// 冒烟脚本的 PID 变量名（core/release/scripts/install-smoke-core.sh 自己用）。
pub const ENV_SMOKE_PID: &str = "DSH_PID";
/// 灰度总开关的读取位。
pub const ENV_CANARY: &str = "DSH_CANARY";
/// 灰度身份名单的读取位。
pub const ENV_CANARY_ID: &str = "DSH_CANARY_ID";
/// 灰度允许名单包名的读取位。
pub const ENV_CANARY_ALLOWLIST: &str = "DSH_CANARY_ALLOWLIST";
/// 部署形态的读取位：内核据此区分安装形态。
pub const ENV_DEPLOY_FORM: &str = "DSH_DEPLOY_FORM";
/// 面板静态目录覆盖位：内核 api/static.js 的 UI 落点。
pub const ENV_UI_DIR: &str = "DSH_UI_DIR";
/// 跳过 UI 安装构建的开关位：构建脚本与 CI 用。
pub const ENV_UI_SKIP_INSTALL: &str = "DSH_UI_SKIP_INSTALL";
/// 内核发布 scope 覆盖位：发布脚本用。
pub const ENV_CORE_SCOPE: &str = "DSH_CORE_SCOPE";
/// 发布用 registry 覆盖位：CI 与发布脚本共用。
pub const ENV_PUBLISH_REGISTRY: &str = "DSH_PUBLISH_REGISTRY";
/// npm provenance 开关位：CI 仓库变量与发布脚本共用。
pub const ENV_NPM_PROVENANCE: &str = "DSH_NPM_PROVENANCE";
/// 临时 .npmrc 路径位：凭据脚本与发布脚本共用。
pub const ENV_NPMRC: &str = "DSH_NPMRC";
/// 旧 npm 令牌暂存位（凭据脚本内部）。
pub const ENV_NPM_AUTH_PREV: &str = "DSH_NPM_AUTH_PREV";
/// 旧 npm 令牌是否存在的标志位（凭据脚本内部）。
pub const ENV_NPM_AUTH_PREV_SET: &str = "DSH_NPM_AUTH_PREV_SET";
/// 旧 npm 令牌行的暂存位（凭据脚本内部）。
pub const ENV_NPM_AUTH_PREVL: &str = "DSH_NPM_AUTH_PREVL";
/// 旧 npm 令牌行是否存在的标志位（凭据脚本内部）。
pub const ENV_NPM_AUTH_PREVL_SET: &str = "DSH_NPM_AUTH_PREVL_SET";
/// npm 凭据来源标记位（凭据脚本内部）。
pub const ENV_NPM_AUTH_SOURCE: &str = "DSH_NPM_AUTH_SOURCE";
/// npm 凭据临时目录位（凭据脚本内部）。
pub const ENV_NPM_AUTH_TMP: &str = "DSH_NPM_AUTH_TMP";
/// 凭据目录覆盖位：发布凭据的落点。
pub const ENV_CRED_DIR: &str = "DSH_CRED_DIR";
/// 允许覆盖已有凭据的开关位。
pub const ENV_CRED_ALLOW_OVERWRITE: &str = "DSH_CRED_ALLOW_OVERWRITE";
/// 强制覆盖凭据的开关位。
pub const ENV_CRED_FORCE: &str = "DSH_CRED_FORCE";
/// 凭据备份目录覆盖位。
pub const ENV_CRED_BACKUP_DIR: &str = "DSH_CRED_BACKUP_DIR";
/// 真实家目录覆盖位：凭据脚本需要绕开被隔离的 HOME。
pub const ENV_REAL_HOME: &str = "DSH_REAL_HOME";
/// 发布架构覆盖位：CI 与构建脚本用。
pub const ENV_ARCH_OVERRIDE: &str = "DSH_ARCH_OVERRIDE";
/// 发布平台覆盖位：CI 与构建脚本用。
pub const ENV_PLATFORM_OVERRIDE: &str = "DSH_PLATFORM_OVERRIDE";
/// esbuild 版本钉死位：launcher 构建用。
pub const ENV_ESBUILD_VERSION: &str = "DSH_ESBUILD_VERSION";
/// 版本号读取库路径位：版本提升与发布脚本用。
pub const ENV_VERSION_LIB: &str = "DSH_VERSION_LIB";

// ── 服务 / 计划任务 / systemd unit / macOS label ─────────────────────────────
/// Windows 守卫计划任务名：schtasks /Create /Query /Run /End /Delete 全用这个名字。
pub const WINDOWS_GUARD_TASK: &str = "Lobox";
/// Windows 监控计划任务名：每 5 分钟拉起守卫，漏改等于监控失效。
pub const WINDOWS_WATCHDOG_TASK: &str = "Lobox-Watchdog";
/// Windows 壳登录自启计划任务名：由内核自启层建立/删除，壳侧不碰。
pub const WINDOWS_GUI_TASK: &str = "Lobox-Shell";
/// Windows 登录自启的**兜底通道**值名（HKCU\...\Run 下的值名，schtasks 不可用时用）：与计划任务名同属我们的服务标识。
pub const WINDOWS_RUN_VALUE: &str = "Lobox";
/// systemd 用户单元短名：systemctl --user start/stop/enable/disable 的操作对象。
pub const SYSTEMD_UNIT_NAME: &str = "lobox";
/// systemd 用户单元文件名：落点 ~/.config/systemd/user/<该名>。
pub const SYSTEMD_UNIT_FILE: &str = "lobox.service";
/// macOS 守卫 LaunchAgent label：`<identifier>.core`，由 [`TAURI_IDENTIFIER`] 派生（反向域名根只写一次）。
/// 为什么是求值函数而不是常量：std 没有 const 字符串拼接（`concat!` 只接受字面量），写死字面量等于把根抄第二遍。
pub fn macos_guard_label() -> String {
    format!("{}.core", TAURI_IDENTIFIER)
}
/// macOS 壳 LaunchAgent label：`<identifier>.shell`，同上派生（内核自启层建立/删除壳的登录项）。
pub fn macos_gui_label() -> String {
    format!("{}.shell", TAURI_IDENTIFIER)
}

// ── 产物名模板 ──────────────────────────────────────────────────────────────
/// 内核 SEA 产物名：esbuild 打包 bin 的输出文件名。
pub const SEA_BUNDLE_NAME: &str = "core.cjs";
/// 版本注入宏名：esbuild --define 的键，也是内核读自报版本的常量名。
pub const SEA_VERSION_DEFINE: &str = "__DSH_VERSION__";
/// 内核源码归档名模板：release.sh 的 PAK + .tar.gz。
pub const KERNEL_ARCHIVE_TEMPLATE: &str = "lobox-{ver}.tar.gz";
/// 内核 GitHub Release 资产名模板：core.yml 逐平台打包的 tar.gz。
pub const KERNEL_RELEASE_TARBALL_TEMPLATE: &str = "lobox-kernel-{ver}-{plat}.tar.gz";
/// 内核 launcher 产物目录名模板：build-launcher.sh 派生、publish-core.sh 回读。
pub const LAUNCHER_DIR_TEMPLATE: &str = "lobox-{ver}-{plat}-{arch}";
/// Windows NSIS 安装包名模板（Tauri 由 productName 派生）。
pub const INSTALLER_NSIS_WIN_X64_TEMPLATE: &str = "{product}_{ver}_x64-setup.exe";
/// macOS .app 归档名模板（updater 资产）。
pub const INSTALLER_MACOS_APP_TEMPLATE: &str = "{product}.app.tar.gz";
/// Linux deb 包名模板。
pub const INSTALLER_DEB_LINUX_X64_TEMPLATE: &str = "{product}_{ver}_amd64.deb";
/// macOS arm64 dmg 名模板。
pub const INSTALLER_DMG_ARM64_TEMPLATE: &str = "{product}_{ver}_aarch64.dmg";
/// macOS x64 dmg 名模板。
pub const INSTALLER_DMG_X64_TEMPLATE: &str = "{product}_{ver}_x64.dmg";
/// Windows 上内核可执行名的三种形态：壳在 %APPDATA%\npm 与新前缀下按它探测。
pub const CLI_BIN_NAMES: &[&str] = &["lobox.exe", "lobox.cmd", "lobox"];
/// 安装冒烟在 PATH 上找内核入口的三种形态。
pub const CLI_SHIM_NAMES: &[&str] = &["lobox", "lobox.cmd", "lobox.ps1"];
/// 桌面壳可执行名的两种形态。
pub const GUI_BIN_NAMES: &[&str] = &["lobox-shell", "lobox-shell.exe"];

// ── 进程匹配模式 ────────────────────────────────────────────────────────────
/// 守卫进程的命令行匹配模式：Windows 按命令行含此串精确杀守卫（镜像名是 node.exe，按镜像名杀不到）。
pub const PROC_MATCH_GUARD: &str = shared_str("proc.matchGuard");
/// 壳进程名匹配串：内核用 pgrep 找壳进程。
pub const PROC_MATCH_GUI: &str = "lobox-shell";
/// 壳进程正则源：内核 isShellProcess 判命令行是否属于壳（.exe 可选）。
pub const PROC_MATCH_GUI_RE: &str = "lobox-shell(\\.exe)?";

// ── 跨侧契约字段（波 3）───────────────────────────────────────────────────────
// 与 brand.js 同名同值。内核（core/**，含面板 bundle core/ui/**）与壳（shell/**，Tauri）是各自独立发布的
//   两个产物：下面每个名字都同时出现在两侧的代码字面量里，只改一侧 = 契约断裂（现场只有「更新按钮没反应」）。
// 破坏性：本产品尚未对外发布，老安装按 D 系列决策不迁移、不提供兼容期 ⇒ 旧名字一律不再被识别。
// `dsh` 在下面唯一的语义是「被监管的 DSH harness 本体」：事件类型名里用通用词 `harness` 取代它，
//   使「去 dsh 前缀」不变成说谎（`lobox_exited` 会谎称是我们自己退出）。

/// 面板 → 壳 的内核更新请求消息类型名（引导页 `shell.html` 经 `shell_bridge_contract` 取得本值）。
pub const BRIDGE_MSG_KERNEL_UPDATE_REQUEST: &str = shared_str("bridge.msgKernelUpdateRequest");
/// 壳 → 面板 的终结结果消息类型名。
pub const BRIDGE_MSG_KERNEL_UPDATE_RESULT: &str = shared_str("bridge.msgKernelUpdateResult");
/// 壳 → 面板 的非终结进度消息类型名。
pub const BRIDGE_MSG_KERNEL_UPDATE_PROGRESS: &str = shared_str("bridge.msgKernelUpdateProgress");
/// 浏览器 localStorage 键：出回环访问密钥（面板 `services/supervisor/client.ts` 消费，我方签发/校验）。
pub const STORE_KEY_API_ACCESS: &str = "lobox.apiAccessKey";
/// LAN 门卫 cookie 名：**我方**签发并校验（与 harness 签发的 `dsh-auth-*` 无关）。
pub const COOKIE_LAN_TOKEN: &str = "lobox_lan_token";

/// 内核事件类型名：内核 `events.append()` 产生 → 面板 `nav.ts` / `OverviewPage.tsx` 消费（harness 不读写它）。
pub const EVENT_HARNESS_EXITED: &str = "harness_exited";
/// 见 [`EVENT_HARNESS_EXITED`]：harness 会话令牌已捕获。
pub const EVENT_HARNESS_TOKEN_CAPTURED: &str = "harness_token_captured";
/// 见 [`EVENT_HARNESS_EXITED`]：harness 会话令牌缺失（等待捕获）。
pub const EVENT_HARNESS_TOKEN_MISSING: &str = "harness_token_missing";
/// 见 [`EVENT_HARNESS_EXITED`]：启动命令缺失（ENOENT）。
pub const EVENT_HARNESS_COMMAND_MISSING: &str = "harness_command_missing";
/// 见 [`EVENT_HARNESS_EXITED`]：未检测到 harness 安装。
pub const EVENT_HARNESS_NOT_INSTALLED: &str = "harness_not_installed";
/// 见 [`EVENT_HARNESS_EXITED`]：裸命令名已绑定到真实入口。
pub const EVENT_HARNESS_COMMAND_BOUND: &str = "harness_command_bound";
/// 见 [`EVENT_HARNESS_EXITED`]：主实例监控开关变更。
pub const EVENT_HARNESS_GUARDIAN_CHANGED: &str = "harness_guardian_changed";
/// 见 [`EVENT_HARNESS_EXITED`]：主实例远程模式变更。
pub const EVENT_HARNESS_REMOTE_CHANGED: &str = "harness_remote_changed";
/// 见 [`EVENT_HARNESS_EXITED`]：主实例远程访问令牌变更。
pub const EVENT_HARNESS_REMOTE_TOKEN_CHANGED: &str = "harness_remote_token_changed";
/// 见 [`EVENT_HARNESS_EXITED`]：LAN 代理持有的 harness 会话令牌已刷新。
pub const EVENT_LAN_HARNESS_TOKEN_UPDATED: &str = "lan_harness_token_updated";
/// 见 [`EVENT_HARNESS_EXITED`]：为升级而停止 harness。
pub const EVENT_UPGRADE_STOPPING_HARNESS: &str = "upgrade_stopping_harness";
/// 见 [`EVENT_HARNESS_EXITED`]：壳更新待应用（壳侧事件，与内核单源同名同值）。
pub const EVENT_SHELL_UPDATE_PENDING: &str = "shell_update_pending";
/// 见 [`EVENT_HARNESS_EXITED`]：壳更新已检查。
pub const EVENT_SHELL_UPDATE_CHECKED: &str = "shell_update_checked";
/// 见 [`EVENT_HARNESS_EXITED`]：壳请求重启。
pub const EVENT_SHELL_RESTART_REQUESTED: &str = "shell_restart_requested";

/// systemd 模板让位后缀：模板名 `dsh-web@.service` 属被监管产品（不改），后缀是我方加的标记。
pub const SYSTEMD_TEMPLATE_ASIDE_SUFFIX: &str = ".disabled-by-lobox-";

/// 家目录 + 相对段 的拼接（状态根三平台规则的共同动作）。
fn home_join(home: &Path, segments: &[&str]) -> PathBuf {
    segments.iter().fold(home.to_path_buf(), |p, s| p.join(*s))
}

/// 环境变量基座的统一归一化（与 brand.js 的 `envBase` **逐字同规则**）：
///   `trim()` 后为空即视为**未设置**（`None` ⇒ 调用方回落），否则取 trim 后的值。
///   为什么"纯空白 = 未设置"：空白基座在文件系统上不可用，拼出来是形如 `"   \lobox"` 的畸形路径。
///   为什么取 trim 后的值：与本仓既有取值点同惯例 —— env.rs 的覆盖位 `PathBuf::from(v.trim())`。
///   ⚠ 两个分支都必须经本函数（Windows 分支曾用 `.filter(|s| !s.trim().is_empty())` 但不 trim 值、
///     Linux 分支曾只查 `is_empty()`，与 brand.js 的规则不一致过）。
fn env_base(value: Option<String>) -> Option<String> {
    value.map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

/// `env_base` 的 `OsString` 版：同一条「trim 后为空 = 未设置」规则，但保留本模块既有性质 ——
///   合法 UTF-8 基座连值一起 trim（与 brand.js 逐字一致）；非 UTF-8 基座（JS 侧无对应表示）只对
///   `to_string_lossy()` 做一次空白判定，判定通过则用**原 OsString**，不做二次解码。
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

/// 状态根推导规则（Windows）：基座取 `LOCALAPPDATA`（**trim 后为空或缺失**则退回 <家>/AppData/Local），拼状态根目录名。
pub fn state_root_windows(local_appdata: Option<String>, home: &Path) -> PathBuf {
    let base = env_base(local_appdata)
        .map(PathBuf::from)
        .unwrap_or_else(|| home_join(home, STATE_ROOT_WIN_BASE_FALLBACK_SEGMENTS));
    base.join(STATE_DIR_NAME)
}

/// 状态根推导规则（macOS）：<家>/Library/Application Support/ + 状态根目录名。
pub fn state_root_macos(home: &Path) -> PathBuf {
    home_join(home, STATE_ROOT_MACOS_SEGMENTS).join(STATE_DIR_NAME)
}

/// 状态根推导规则（Linux 及未支持平台）：基座取 `XDG_STATE_HOME`（**trim 后为空或缺失**则退回 <家>/.local/state），拼状态根目录名。
/// 基座经 `env_base_os`：合法 UTF-8 时取 trim 后的值；非 UTF-8 的 XDG 基座不做二次解码。
pub fn state_root_linux(xdg_state_home: Option<std::ffi::OsString>, home: &Path) -> PathBuf {
    let base = env_base_os(xdg_state_home)
        .map(PathBuf::from)
        .unwrap_or_else(|| home_join(home, STATE_ROOT_LINUX_FALLBACK_SEGMENTS));
    base.join(STATE_DIR_NAME)
}
