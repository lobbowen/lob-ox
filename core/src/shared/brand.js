'use strict';



const path = require('node:path');


const SHARED = require('./shared-constants');


const PRODUCT_NAME = SHARED.product.name;

// CLI_NAME 有真实消费方（core/bin/lobox：链接名 / 版本输出 / bin 目录定位）。
const CLI_NAME = SHARED.product.cliName;

const GUI_BIN_NAME = SHARED.product.guiBinName;


// NPM_SCOPE / CORE_PKG_PREFIX 仅由 corePackageName() 内部拼接，不导出。
const NPM_SCOPE = SHARED.product.npmScope;

const CORE_PKG_PREFIX = SHARED.product.corePkgPrefix;


// STATE_* / LEGACY_* 仅由 stateRoot() / legacyStateRoot() 内部使用（不导出）。
const STATE_DIR_NAME = SHARED.state.dirName;

const STATE_SUPERVISOR_SUBDIR = SHARED.state.supervisorSubdir;

const STATE_SHELL_SUBDIR = SHARED.state.shellSubdir;

const LEGACY_PRODUCT_NAME = SHARED.state.legacyProductName;

const STATE_ROOT_WIN_BASE_ENV = SHARED.state.winBaseEnv;

const STATE_ROOT_WIN_BASE_FALLBACK_SEGMENTS = SHARED.state.winFallbackSegments;

const STATE_ROOT_MACOS_SEGMENTS = SHARED.state.macosSegments;

const STATE_ROOT_LINUX_XDG_ENV = SHARED.state.linuxXdgEnv;

const STATE_ROOT_LINUX_FALLBACK_SEGMENTS = SHARED.state.linuxFallbackSegments;

const LEGACY_HARNESS_DIR = SHARED.state.legacyHarnessDir;


// ENV_* 只有这三个有消费方：ENV_STATE_ROOT（platform/service/state-root.js）、
// ENV_SHELL_EXE（platform/os/autostart/index.js）、ENV_UI_DIR（api/static.js）。
// 其余 ENV_* 常量在 core/src、core/test、core/ui/src 三处零引用，已删除；
// shell/src-tauri/src/brand.rs 中的同名 Rust 常量是独立的一份，不受本次删除影响。
const ENV_STATE_ROOT = SHARED.env.stateRoot;

const ENV_SHELL_EXE = SHARED.env.shell_exe;

const ENV_UI_DIR = SHARED.env.ui_dir;


// TAURI_IDENTIFIER 仅由 macosGuardLabel() / macosGuiLabel() 内部拼接，不导出。
const TAURI_IDENTIFIER = SHARED.product.tauriIdentifier;


const WINDOWS_GUI_TASK = SHARED.platform.windowsGuiTask;

const SYSTEMD_UNIT_FILE = SHARED.platform.systemdUnitFile;

function macosGuardLabel() { return TAURI_IDENTIFIER + '.core'; }
function macosGuiLabel() { return TAURI_IDENTIFIER + '.shell'; }


// SEA_BUNDLE_NAME 有消费方（platform/contract/deploy.js），保留。
const SEA_BUNDLE_NAME = SHARED.packaging.seaBundleName;




const COOKIE_LAN_TOKEN = SHARED.store.cookieLanToken;


// EVENT_HARNESS_EXITED 有消费方（app/main/process.js、app/main/controller.js），保留。
const EVENT_HARNESS_EXITED = SHARED.event.harness_exited;
const EVENT_HARNESS_TOKEN_CAPTURED = SHARED.event.harness_token_captured;
const EVENT_HARNESS_TOKEN_MISSING = SHARED.event.harness_token_missing;
const EVENT_HARNESS_COMMAND_MISSING = SHARED.event.harness_command_missing;
const EVENT_HARNESS_NOT_INSTALLED = SHARED.event.harness_not_installed;
const EVENT_HARNESS_COMMAND_BOUND = SHARED.event.harness_command_bound;
const EVENT_LAN_HARNESS_TOKEN_UPDATED = SHARED.event.lan_harness_token_updated;

const EVENT_SHELL_UPDATE_CHECKED = SHARED.event.shell_update_checked;


const SYSTEMD_TEMPLATE_ASIDE_SUFFIX = SHARED.platform.systemdTemplateAsideSuffix;

// PROC_MATCH_GUARD 的消费方是 platform/os/pidlookup（进程归属判据）。
// 此前 shared-constants.proc.matchGuard 已在 JSON 单源中存在，但本文件从未把它
// 导出，pidlookup 读到 undefined 后回退到硬编码 /dsh|lobox/i —— 该回退漏掉
// npm scope 形态 @lob-ox（连字符），导致改名后的内核被判为外部进程。
const PROC_MATCH_GUARD = SHARED.proc.matchGuard;


function corePackageName(tag) {
  return NPM_SCOPE + '/' + CORE_PKG_PREFIX + tag;
}


function envBase(env, name) {
  const raw = env[name];
  if (raw === undefined || raw === null) return null;
  const s = String(raw).trim();
  return s === '' ? null : s;
}


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


function legacyStateRoot(platform, env, home) {
  return path.join(path.dirname(stateRoot(platform, env, home)), LEGACY_PRODUCT_NAME);
}

// 注：TAURI_IDENTIFIER / STATE_* / LEGACY_HARNESS_DIR 等是模块私有实现细节，
// 外部一律经由 stateRoot() / legacyStateRoot() / macosGuardLabel() / macosGuiLabel()
// 这些函数间接取得——否则单点改名要追着全仓常量改。
// core/test/contract-assertions-test.js 会读本文件源码抽
// `const EVENT_* = SHARED.event.<key>`（含旧的字面量形状）建事件名映射，
// 新增事件常量请保持这个书写形状。
module.exports = {
  PRODUCT_NAME,
  STATE_SUPERVISOR_SUBDIR,
  STATE_SHELL_SUBDIR,
  CLI_NAME,
  GUI_BIN_NAME,
  ENV_STATE_ROOT,
  ENV_SHELL_EXE,
  ENV_UI_DIR,
  WINDOWS_GUI_TASK,
  SYSTEMD_UNIT_FILE,
  macosGuardLabel,
  macosGuiLabel,
  SEA_BUNDLE_NAME,
  COOKIE_LAN_TOKEN,
  EVENT_HARNESS_EXITED,
  EVENT_HARNESS_TOKEN_CAPTURED,
  EVENT_HARNESS_TOKEN_MISSING,
  EVENT_HARNESS_COMMAND_MISSING,
  EVENT_HARNESS_NOT_INSTALLED,
  EVENT_HARNESS_COMMAND_BOUND,
  EVENT_LAN_HARNESS_TOKEN_UPDATED,
  EVENT_SHELL_UPDATE_CHECKED,
  SYSTEMD_TEMPLATE_ASIDE_SUFFIX,
  PROC_MATCH_GUARD,
  corePackageName,
  stateRoot,
  legacyStateRoot,
};
