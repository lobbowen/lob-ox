'use strict';

// 品牌与命名的跨语言单源（CommonJS，只用 Node 内置 node:path，无第三方依赖）。
//   本文件与 `shell/src-tauri/src/brand.rs` 声明**同一组常量名**与逐字相同的值；
//   `core/test/brand-single-source-test.js` 解析 brand.rs 并逐项对账本文件 —— 只改一边必判红。
// 只放名字与规则，不放行为：每条都是一个对外可见的字面量（产品名/包名/状态根/服务名/环境变量/产物名/进程模式）。
// 消费方式：内核 `require` 取常量；壳取 `crate::brand::<同名常量>`。
// 本波（核心标识改名）已改：产品名/CLI/壳 crate+bin/npm 子包前缀/状态根目录名/服务与 unit 与 label/产物名。
//   ⚠ `LEGACY_PRODUCT_NAME` 是**唯一**保留旧名的常量：它只用于「检测旧状态根 + 认旧守卫」，
//   不参与任何新命名（D-2/P-2：旧状态不迁移，但绝不静默）。

const path = require('node:path');

// ── 产品与组件名 ─────────────────────────────────────────────────────────────
// 产品名：状态根/落点路径/安装目录/通知与 UA 等处的产品标识。
const PRODUCT_NAME = 'lobox';
// 内核 CLI 可执行名：core/package.json#bin 的键与值、core/bin/lobox 安装期建立的入口名、壳定位内核的候选名。
const CLI_NAME = 'lobox';
// 桌面壳可执行名（= Cargo 产物名）：壳自定位、内核识别壳进程、CI 冒烟三处共用的入口名。
const GUI_BIN_NAME = 'lobox-shell';
// 桌面壳 crate 名：shell/src-tauri/Cargo.toml#package.name，同时是 shell/scripts/bump-shell.sh 的 sed 锚点。
const GUI_CRATE_NAME = 'lobox-shell';

// ── npm 包 ──────────────────────────────────────────────────────────────────
// npm scope：已发布包名的前缀（core/package.json#npmPublish.scope，已发布包不可改）。
const NPM_SCOPE = '@lob-ox';
// 内核平台子包名的前缀（不含 scope）：与平台标签拼接成裸包名 core-<tag>。
const CORE_PKG_PREFIX = 'core-';
// 内核平台子包覆盖的四组平台标签：决定 core/package.json#npmPublish.packages 的四条。
const CORE_PKG_TAGS = ['linux-x64', 'darwin-arm64', 'darwin-x64', 'win-x64'];
// 壳更新清单包名：内核查最新壳版本、updater endpoint、壳产物组装三处共用的完整包名。
const SHELL_RELEASE_PKG = '@lob-ox/shell-release';

// ── Tauri 应用身份与安装包名 ─────────────────────────────────────────────────
// Tauri identifier（应用身份）：Windows 卸载项与升级谱系、macOS bundle id、应用数据目录名。
const TAURI_IDENTIFIER = 'dev.bowen.lobox';
// Tauri productName：全部安装包文件名由它派生（nsis/msi/dmg/deb 与 .app.tar.gz）。
const TAURI_PRODUCT_NAME = 'lobox';

// ── 状态根（内核 state-root.js 与壳 env.rs 必须推出同一个根）──────────────────
// 状态根目录名：三平台状态根的**最后一段**，Windows/macOS/Linux 共用。
const STATE_DIR_NAME = 'lobox';
// 状态根下内核侧子目录名：config.json / ports.json / state.json / 日志的落点。
const STATE_SUPERVISOR_SUBDIR = 'supervisor';
// 状态根下壳侧子目录名：identity.json / shell.log / guard 日志的落点。
const STATE_SHELL_SUBDIR = 'shell';
// **旧产品名**（改名前的状态根末段 = 旧 CLI/壳名）：仅用于检测与告警 ——
//   legacyStateRoot() 用它推导旧状态根（不迁移），bin/lobox 用它认「旧守卫是否还在跑」。
//   全仓只有这一处允许出现旧名（连同它的 brand.rs 对偶与 brand-single-source-test 的冻结字面量）。
const LEGACY_PRODUCT_NAME = 'dsh-supervisor';
// Windows 状态根基座的环境变量名。
const STATE_ROOT_WIN_BASE_ENV = 'LOCALAPPDATA';
// 基座环境变量缺失时，Windows 状态根在家目录下的相对段（拼出 <家>/AppData/Local）。
const STATE_ROOT_WIN_BASE_FALLBACK_SEGMENTS = ['AppData', 'Local'];
// macOS 状态根在家目录下的相对段（拼出 <家>/Library/Application Support）。
const STATE_ROOT_MACOS_SEGMENTS = ['Library', 'Application Support'];
// Linux 状态根基座的环境变量名（XDG 规范）。
const STATE_ROOT_LINUX_XDG_ENV = 'XDG_STATE_HOME';
// XDG 基座缺失时，Linux 状态根在家目录下的相对段（拼出 <家>/.local/state）。
const STATE_ROOT_LINUX_FALLBACK_SEGMENTS = ['.local', 'state'];
// 旧位置（harness 数据目录）的第一段：迁移来源，绝不能被 harness 的卸载/清理一并带走。
const LEGACY_HARNESS_DIR = '.dsh';

// ── 环境变量（本产品自己的；名字与值都是现状）────────────────────────────────
// 状态根覆盖位：三平台最先命中并绝对化；壳注入服务定义、内核据此定位，两侧必须同名。
const ENV_STATE_ROOT = 'DSH_SUPERVISOR_HOME';
// 配置文件路径覆盖位：CLI 与内核配置装载共用。
const ENV_CONFIG = 'DSH_SUPERVISOR_CONFIG';
// 单实例锁文件路径覆盖位：守卫与 CLI 共用。
const ENV_LOCK_FILE = 'DSH_SUPERVISOR_LOCK_FILE';
// 内核可执行覆盖位：自启层解析可执行文件时的第一候选。
const ENV_DAEMON = 'DSH_SUPERVISOR_DAEMON';
// 托盘端口覆盖位：壳读它决定托盘桥端口。
const ENV_TRAY_PORT = 'DSH_SUPERVISOR_TRAY_PORT';
// 壳可执行覆盖位：自启层解析壳可执行文件时的第一候选。
const ENV_SHELL_EXE = 'DSH_SHELL_EXE';
// 守卫可执行覆盖位：壳的服务定义自检与 CI 冒烟用来注入占位文件。
const ENV_GUARD_BIN = 'DSH_GUARD_BIN';
// 被监管 harness 可执行覆盖位：内核解析 dsh 入口时优先读它。
const ENV_HARNESS_BIN = 'DSH_BIN';
// 冒烟脚本的 PID 变量名（core/release/scripts/install-smoke-core.sh 自己用）。
const ENV_SMOKE_PID = 'DSH_PID';
// 灰度总开关的读取位。
const ENV_CANARY = 'DSH_CANARY';
// 灰度身份名单的读取位。
const ENV_CANARY_ID = 'DSH_CANARY_ID';
// 灰度允许名单包名的读取位。
const ENV_CANARY_ALLOWLIST = 'DSH_CANARY_ALLOWLIST';
// 部署形态的读取位：内核据此区分安装形态。
const ENV_DEPLOY_FORM = 'DSH_DEPLOY_FORM';
// 面板静态目录覆盖位：内核 api/static.js 的 UI 落点。
const ENV_UI_DIR = 'DSH_UI_DIR';
// 跳过 UI 安装构建的开关位：构建脚本与 CI 用。
const ENV_UI_SKIP_INSTALL = 'DSH_UI_SKIP_INSTALL';
// 内核发布 scope 覆盖位：发布脚本用。
const ENV_CORE_SCOPE = 'DSH_CORE_SCOPE';
// 发布用 registry 覆盖位：CI 与发布脚本共用。
const ENV_PUBLISH_REGISTRY = 'DSH_PUBLISH_REGISTRY';
// npm provenance 开关位：CI 仓库变量与发布脚本共用。
const ENV_NPM_PROVENANCE = 'DSH_NPM_PROVENANCE';
// 临时 .npmrc 路径位：凭据脚本与发布脚本共用。
const ENV_NPMRC = 'DSH_NPMRC';
// 旧 npm 令牌暂存位（凭据脚本内部）。
const ENV_NPM_AUTH_PREV = 'DSH_NPM_AUTH_PREV';
// 旧 npm 令牌是否存在的标志位（凭据脚本内部）。
const ENV_NPM_AUTH_PREV_SET = 'DSH_NPM_AUTH_PREV_SET';
// 旧 npm 令牌行的暂存位（凭据脚本内部）。
const ENV_NPM_AUTH_PREVL = 'DSH_NPM_AUTH_PREVL';
// 旧 npm 令牌行是否存在的标志位（凭据脚本内部）。
const ENV_NPM_AUTH_PREVL_SET = 'DSH_NPM_AUTH_PREVL_SET';
// npm 凭据来源标记位（凭据脚本内部）。
const ENV_NPM_AUTH_SOURCE = 'DSH_NPM_AUTH_SOURCE';
// npm 凭据临时目录位（凭据脚本内部）。
const ENV_NPM_AUTH_TMP = 'DSH_NPM_AUTH_TMP';
// 凭据目录覆盖位：发布凭据的落点。
const ENV_CRED_DIR = 'DSH_CRED_DIR';
// 允许覆盖已有凭据的开关位。
const ENV_CRED_ALLOW_OVERWRITE = 'DSH_CRED_ALLOW_OVERWRITE';
// 强制覆盖凭据的开关位。
const ENV_CRED_FORCE = 'DSH_CRED_FORCE';
// 凭据备份目录覆盖位。
const ENV_CRED_BACKUP_DIR = 'DSH_CRED_BACKUP_DIR';
// 真实家目录覆盖位：凭据脚本需要绕开被隔离的 HOME。
const ENV_REAL_HOME = 'DSH_REAL_HOME';
// 发布架构覆盖位：CI 与构建脚本用。
const ENV_ARCH_OVERRIDE = 'DSH_ARCH_OVERRIDE';
// 发布平台覆盖位：CI 与构建脚本用。
const ENV_PLATFORM_OVERRIDE = 'DSH_PLATFORM_OVERRIDE';
// esbuild 版本钉死位：launcher 构建用。
const ENV_ESBUILD_VERSION = 'DSH_ESBUILD_VERSION';
// 版本号读取库路径位：版本提升与发布脚本用。
const ENV_VERSION_LIB = 'DSH_VERSION_LIB';

// ── 服务 / 计划任务 / systemd unit / macOS label ─────────────────────────────
// Windows 守卫计划任务名：schtasks /Create /Query /Run /End /Delete 全用这个名字。
const WINDOWS_GUARD_TASK = 'Lobox';
// Windows 看护计划任务名：每 5 分钟拉起守卫，漏改等于看护失效。
const WINDOWS_WATCHDOG_TASK = 'Lobox-Watchdog';
// Windows 壳登录自启计划任务名：由内核自启层建立/删除，壳侧不碰。
const WINDOWS_GUI_TASK = 'Lobox-Shell';
// Windows 登录自启的**兜底通道**值名（HKCU\...\Run 下的值名，schtasks 不可用时用）：与计划任务名同属我们的服务标识。
const WINDOWS_RUN_VALUE = 'Lobox';
// systemd 用户单元短名：systemctl --user start/stop/enable/disable 的操作对象。
const SYSTEMD_UNIT_NAME = 'lobox';
// systemd 用户单元文件名：落点 ~/.config/systemd/user/<该名>。
const SYSTEMD_UNIT_FILE = 'lobox.service';
// macOS LaunchAgent label 的**反向域名根只有一处**：TAURI_IDENTIFIER。label = <identifier>.<组件>，
//   它是 plist 文件名与 launchctl bootstrap/bootout/kickstart/enable/disable 的操作对象（内核与壳两侧都认它）。
// 为什么是求值函数而不是常量：Rust 侧没有 const 字符串拼接（std 无 const-concat，`concat!` 只吃字面量），
//   要让两侧**都**从 identifier 派生就只能都走函数；写死两个字面量 = 反向域名根被抄第二遍，改 identifier 必分叉
//   （波 1 的 `com.lobox.*` vs `dev.bowen.lobox` 正是这么分叉的）。断言见 test/brand-single-source-test.js I 段。
function macosGuardLabel() { return TAURI_IDENTIFIER + '.core'; }
function macosGuiLabel() { return TAURI_IDENTIFIER + '.shell'; }

// ── 产物名模板 ──────────────────────────────────────────────────────────────
// 内核 SEA 产物名：esbuild 打包 bin 的输出文件名。
const SEA_BUNDLE_NAME = 'core.cjs';
// 版本注入宏名：esbuild --define 的键，也是内核读自报版本的常量名。
const SEA_VERSION_DEFINE = '__DSH_VERSION__';
// 内核源码归档名模板：release.sh 的 PAK + .tar.gz。
const KERNEL_ARCHIVE_TEMPLATE = 'lobox-{ver}.tar.gz';
// 内核 GitHub Release 资产名模板：core.yml 逐平台打包的 tar.gz。
const KERNEL_RELEASE_TARBALL_TEMPLATE = 'lobox-kernel-{ver}-{plat}.tar.gz';
// 内核 launcher 产物目录名模板：build-launcher.sh 派生、publish-core.sh 回读。
const LAUNCHER_DIR_TEMPLATE = 'lobox-{ver}-{plat}-{arch}';
// Windows NSIS 安装包名模板（Tauri 由 productName 派生）。
const INSTALLER_NSIS_WIN_X64_TEMPLATE = '{product}_{ver}_x64-setup.exe';
// macOS .app 归档名模板（updater 资产）。
const INSTALLER_MACOS_APP_TEMPLATE = '{product}.app.tar.gz';
// Linux deb 包名模板。
const INSTALLER_DEB_LINUX_X64_TEMPLATE = '{product}_{ver}_amd64.deb';
// macOS arm64 dmg 名模板。
const INSTALLER_DMG_ARM64_TEMPLATE = '{product}_{ver}_aarch64.dmg';
// macOS x64 dmg 名模板。
const INSTALLER_DMG_X64_TEMPLATE = '{product}_{ver}_x64.dmg';
// Windows 上内核可执行名的三种形态：壳在 %APPDATA%\npm 与新前缀下按它探测。
const CLI_BIN_NAMES = ['lobox.exe', 'lobox.cmd', 'lobox'];
// 安装冒烟在 PATH 上找内核入口的三种形态。
const CLI_SHIM_NAMES = ['lobox', 'lobox.cmd', 'lobox.ps1'];
// 桌面壳可执行名的两种形态。
const GUI_BIN_NAMES = ['lobox-shell', 'lobox-shell.exe'];

// ── 进程匹配模式 ────────────────────────────────────────────────────────────
// 守卫进程的命令行匹配模式：Windows 按命令行含此串精确杀守卫（镜像名是 node.exe，按镜像名杀不到）。
const PROC_MATCH_GUARD = '*lobox*';
// 壳进程名匹配串：内核用 pgrep 找壳进程。
const PROC_MATCH_GUI = 'lobox-shell';
// 壳进程正则源：内核 isShellProcess 判命令行是否属于壳（.exe 可选）。
const PROC_MATCH_GUI_RE = 'lobox-shell(\\.exe)?';

// 内核平台子包名的拼接规则：scope + '/' + 前缀 + 平台标签。
function corePackageName(tag) {
  return NPM_SCOPE + '/' + CORE_PKG_PREFIX + tag;
}

// 环境变量基座的统一归一化（与 brand.rs 的 `env_base` **逐字同规则**）：
//   取值 → String 化 → `trim()`；trim 后为空即视为**未设置**（返回 null ⇒ 调用方回落），否则取 trim 后的值。
//   为什么"纯空白 = 未设置"：空白基座在文件系统上不可用，拼出来是形如 `"   \lobox"` 的畸形路径。
//   为什么取 trim 后的值：与本仓三处既有取值点同惯例 ——
//     state-root.js 的覆盖位 `String(override).trim()`、env.rs 的覆盖位 `PathBuf::from(v.trim())`、
//     install-id.js 的 `env.trim()`：都是「trim 后为空 = 未设置，非空取 trim 后的值」。
//   ⚠ 两平台分支必须都经本函数（Windows 基座曾用 `||`、Linux 曾内联 trim，两侧规则不一致过）。
function envBase(env, name) {
  const raw = env[name];
  if (raw === undefined || raw === null) return null;
  const s = String(raw).trim();
  return s === '' ? null : s;
}

// 状态根推导规则（不含 override 分支）：
//   win32  → <LOCALAPPDATA 或 <家>/AppData/Local>/lobox
//   darwin → <家>/Library/Application Support/lobox
//   其余   → <XDG_STATE_HOME 或 <家>/.local/state>/lobox
// 两个基座都先过 envBase（纯空白 = 未设置 = 回落）；darwin 无基座，家目录由调用方给出。
// override（三平台最先命中、绝对化）留在消费点 state-root.js，本函数只表达平台分支。
function stateRoot(platform, env, home) {
  if (platform === 'win32') {
    const base = envBase(env, STATE_ROOT_WIN_BASE_ENV)
      || path.join(home, ...STATE_ROOT_WIN_BASE_FALLBACK_SEGMENTS);
    return path.join(base, STATE_DIR_NAME);
  }
  if (platform === 'darwin') {
    return path.join(home, ...STATE_ROOT_MACOS_SEGMENTS, STATE_DIR_NAME);
  }
  const xdg = envBase(env, STATE_ROOT_LINUX_XDG_ENV);
  return xdg
    ? path.join(xdg, STATE_DIR_NAME)
    : path.join(home, ...STATE_ROOT_LINUX_FALLBACK_SEGMENTS, STATE_DIR_NAME);
}

// **旧产品状态根**（末段 = LEGACY_PRODUCT_NAME）推导规则：与 stateRoot **同一套基座规则**，
//   只把末段换成旧产品名 —— 取当前根的父目录再拼旧名，规则只有一份，基座不可能只漂移一边。
// 用途**仅限检测与告警**（bin/lobox 启动时报「旧状态根存在 / 旧守卫仍在运行」）：
//   D-2/P-2 已裁定**不迁移**旧状态（新根新起、旧装手动清理），但绝不静默（见 state-root.js#detectLegacyInstall）。
function legacyStateRoot(platform, env, home) {
  return path.join(path.dirname(stateRoot(platform, env, home)), LEGACY_PRODUCT_NAME);
}

module.exports = {
  PRODUCT_NAME,
  CLI_NAME,
  GUI_BIN_NAME,
  GUI_CRATE_NAME,
  NPM_SCOPE,
  CORE_PKG_PREFIX,
  CORE_PKG_TAGS,
  SHELL_RELEASE_PKG,
  TAURI_IDENTIFIER,
  TAURI_PRODUCT_NAME,
  STATE_DIR_NAME,
  STATE_SUPERVISOR_SUBDIR,
  STATE_SHELL_SUBDIR,
  LEGACY_PRODUCT_NAME,
  STATE_ROOT_WIN_BASE_ENV,
  STATE_ROOT_WIN_BASE_FALLBACK_SEGMENTS,
  STATE_ROOT_MACOS_SEGMENTS,
  STATE_ROOT_LINUX_XDG_ENV,
  STATE_ROOT_LINUX_FALLBACK_SEGMENTS,
  LEGACY_HARNESS_DIR,
  ENV_STATE_ROOT,
  ENV_CONFIG,
  ENV_LOCK_FILE,
  ENV_DAEMON,
  ENV_TRAY_PORT,
  ENV_SHELL_EXE,
  ENV_GUARD_BIN,
  ENV_HARNESS_BIN,
  ENV_SMOKE_PID,
  ENV_CANARY,
  ENV_CANARY_ID,
  ENV_CANARY_ALLOWLIST,
  ENV_DEPLOY_FORM,
  ENV_UI_DIR,
  ENV_UI_SKIP_INSTALL,
  ENV_CORE_SCOPE,
  ENV_PUBLISH_REGISTRY,
  ENV_NPM_PROVENANCE,
  ENV_NPMRC,
  ENV_NPM_AUTH_PREV,
  ENV_NPM_AUTH_PREV_SET,
  ENV_NPM_AUTH_PREVL,
  ENV_NPM_AUTH_PREVL_SET,
  ENV_NPM_AUTH_SOURCE,
  ENV_NPM_AUTH_TMP,
  ENV_CRED_DIR,
  ENV_CRED_ALLOW_OVERWRITE,
  ENV_CRED_FORCE,
  ENV_CRED_BACKUP_DIR,
  ENV_REAL_HOME,
  ENV_ARCH_OVERRIDE,
  ENV_PLATFORM_OVERRIDE,
  ENV_ESBUILD_VERSION,
  ENV_VERSION_LIB,
  WINDOWS_GUARD_TASK,
  WINDOWS_WATCHDOG_TASK,
  WINDOWS_GUI_TASK,
  WINDOWS_RUN_VALUE,
  SYSTEMD_UNIT_NAME,
  SYSTEMD_UNIT_FILE,
  macosGuardLabel,
  macosGuiLabel,
  SEA_BUNDLE_NAME,
  SEA_VERSION_DEFINE,
  KERNEL_ARCHIVE_TEMPLATE,
  KERNEL_RELEASE_TARBALL_TEMPLATE,
  LAUNCHER_DIR_TEMPLATE,
  INSTALLER_NSIS_WIN_X64_TEMPLATE,
  INSTALLER_MACOS_APP_TEMPLATE,
  INSTALLER_DEB_LINUX_X64_TEMPLATE,
  INSTALLER_DMG_ARM64_TEMPLATE,
  INSTALLER_DMG_X64_TEMPLATE,
  CLI_BIN_NAMES,
  CLI_SHIM_NAMES,
  GUI_BIN_NAMES,
  PROC_MATCH_GUARD,
  PROC_MATCH_GUI,
  PROC_MATCH_GUI_RE,
  corePackageName,
  stateRoot,
  legacyStateRoot,
};
