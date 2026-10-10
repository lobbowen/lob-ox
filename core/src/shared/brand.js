'use strict';



const path = require('node:path');


const SHARED = require('./shared-constants');


const PRODUCT_NAME = SHARED.product.name;

const CLI_NAME = SHARED.product.cliName;

const GUI_BIN_NAME = SHARED.product.guiBinName;

const GUI_CRATE_NAME = SHARED.product.guiCrateName;


const NPM_SCOPE = '@lob-ox';

const CORE_PKG_PREFIX = 'core-';

const CORE_PKG_TAGS = ['linux-x64', 'darwin-arm64', 'darwin-x64', 'win-x64'];

const SHELL_RELEASE_PKG = '@lob-ox/shell-release';


const TAURI_IDENTIFIER = 'dev.bowen.lobox';

const TAURI_PRODUCT_NAME = 'lobox';


const STATE_DIR_NAME = SHARED.state.dirName;

const STATE_SUPERVISOR_SUBDIR = SHARED.state.supervisorSubdir;

const STATE_SHELL_SUBDIR = SHARED.state.shellSubdir;

const LEGACY_PRODUCT_NAME = 'dsh-supervisor';

const STATE_ROOT_WIN_BASE_ENV = SHARED.state.winBaseEnv;

const STATE_ROOT_WIN_BASE_FALLBACK_SEGMENTS = ['AppData', 'Local'];

const STATE_ROOT_MACOS_SEGMENTS = ['Library', 'Application Support'];

const STATE_ROOT_LINUX_XDG_ENV = SHARED.state.linuxXdgEnv;

const STATE_ROOT_LINUX_FALLBACK_SEGMENTS = ['.local', 'state'];

const LEGACY_HARNESS_DIR = SHARED.state.legacyHarnessDir;


const ENV_STATE_ROOT = SHARED.env.stateRoot;

const ENV_CONFIG = SHARED.env.config;

const ENV_LOCK_FILE = 'DSH_SUPERVISOR_LOCK_FILE';

const ENV_DAEMON = 'DSH_SUPERVISOR_DAEMON';

const ENV_TRAY_PORT = 'DSH_SUPERVISOR_TRAY_PORT';

const ENV_SHELL_EXE = 'DSH_SHELL_EXE';

const ENV_GUARD_BIN = 'DSH_GUARD_BIN';

const ENV_HARNESS_BIN = 'DSH_BIN';

const ENV_SMOKE_PID = 'DSH_PID';

const ENV_CANARY = 'DSH_CANARY';

const ENV_CANARY_ID = 'DSH_CANARY_ID';

const ENV_CANARY_ALLOWLIST = 'DSH_CANARY_ALLOWLIST';

const ENV_DEPLOY_FORM = 'DSH_DEPLOY_FORM';

const ENV_UI_DIR = 'DSH_UI_DIR';

const ENV_UI_SKIP_INSTALL = 'DSH_UI_SKIP_INSTALL';

const ENV_CORE_SCOPE = 'DSH_CORE_SCOPE';

const ENV_PUBLISH_REGISTRY = 'DSH_PUBLISH_REGISTRY';

const ENV_NPM_PROVENANCE = 'DSH_NPM_PROVENANCE';

const ENV_NPMRC = 'DSH_NPMRC';

const ENV_NPM_AUTH_PREV = 'DSH_NPM_AUTH_PREV';

const ENV_NPM_AUTH_PREV_SET = 'DSH_NPM_AUTH_PREV_SET';

const ENV_NPM_AUTH_PREVL = 'DSH_NPM_AUTH_PREVL';

const ENV_NPM_AUTH_PREVL_SET = 'DSH_NPM_AUTH_PREVL_SET';

const ENV_NPM_AUTH_SOURCE = 'DSH_NPM_AUTH_SOURCE';

const ENV_NPM_AUTH_TMP = 'DSH_NPM_AUTH_TMP';

const ENV_CRED_DIR = 'DSH_CRED_DIR';

const ENV_CRED_ALLOW_OVERWRITE = 'DSH_CRED_ALLOW_OVERWRITE';

const ENV_CRED_FORCE = 'DSH_CRED_FORCE';

const ENV_CRED_BACKUP_DIR = 'DSH_CRED_BACKUP_DIR';

const ENV_REAL_HOME = 'DSH_REAL_HOME';

const ENV_ARCH_OVERRIDE = 'DSH_ARCH_OVERRIDE';

const ENV_PLATFORM_OVERRIDE = 'DSH_PLATFORM_OVERRIDE';

const ENV_ESBUILD_VERSION = 'DSH_ESBUILD_VERSION';

const ENV_VERSION_LIB = 'DSH_VERSION_LIB';


const WINDOWS_GUARD_TASK = 'Lobox';

const WINDOWS_WATCHDOG_TASK = 'Lobox-Watchdog';

const WINDOWS_GUI_TASK = 'Lobox-Shell';

const WINDOWS_RUN_VALUE = 'Lobox';

const SYSTEMD_UNIT_NAME = 'lobox';

const SYSTEMD_UNIT_FILE = 'lobox.service';

function macosGuardLabel() { return TAURI_IDENTIFIER + '.core'; }
function macosGuiLabel() { return TAURI_IDENTIFIER + '.shell'; }


const SEA_BUNDLE_NAME = 'core.cjs';

const SEA_VERSION_DEFINE = '__DSH_VERSION__';

const KERNEL_ARCHIVE_TEMPLATE = 'lobox-{ver}.tar.gz';

const KERNEL_RELEASE_TARBALL_TEMPLATE = 'lobox-kernel-{ver}-{plat}.tar.gz';

const LAUNCHER_DIR_TEMPLATE = 'lobox-{ver}-{plat}-{arch}';

const INSTALLER_NSIS_WIN_X64_TEMPLATE = '{product}_{ver}_x64-setup.exe';

const INSTALLER_MACOS_APP_TEMPLATE = '{product}.app.tar.gz';

const INSTALLER_DEB_LINUX_X64_TEMPLATE = '{product}_{ver}_amd64.deb';

const INSTALLER_DMG_ARM64_TEMPLATE = '{product}_{ver}_aarch64.dmg';

const INSTALLER_DMG_X64_TEMPLATE = '{product}_{ver}_x64.dmg';

const CLI_BIN_NAMES = ['lobox.exe', 'lobox.cmd', 'lobox'];

const CLI_SHIM_NAMES = ['lobox', 'lobox.cmd', 'lobox.ps1'];

const GUI_BIN_NAMES = ['lobox-shell', 'lobox-shell.exe'];


const PROC_MATCH_GUARD = SHARED.proc.matchGuard;





const BRIDGE_MSG_KERNEL_UPDATE_REQUEST = SHARED.bridge.msgKernelUpdateRequest;
const BRIDGE_MSG_KERNEL_UPDATE_RESULT = SHARED.bridge.msgKernelUpdateResult;
const BRIDGE_MSG_KERNEL_UPDATE_PROGRESS = SHARED.bridge.msgKernelUpdateProgress;

const STORE_KEY_API_ACCESS = 'lobox.apiAccessKey';

const COOKIE_LAN_TOKEN = 'lobox_lan_token';


const EVENT_HARNESS_EXITED = 'harness_exited';
const EVENT_HARNESS_TOKEN_CAPTURED = 'harness_token_captured';
const EVENT_HARNESS_TOKEN_MISSING = 'harness_token_missing';
const EVENT_HARNESS_COMMAND_MISSING = 'harness_command_missing';
const EVENT_HARNESS_NOT_INSTALLED = 'harness_not_installed';
const EVENT_HARNESS_COMMAND_BOUND = 'harness_command_bound';
const EVENT_HARNESS_GUARDIAN_CHANGED = 'harness_guardian_changed';
const EVENT_HARNESS_REMOTE_CHANGED = 'harness_remote_changed';
const EVENT_HARNESS_REMOTE_TOKEN_CHANGED = 'harness_remote_token_changed';
const EVENT_LAN_HARNESS_TOKEN_UPDATED = 'lan_harness_token_updated';
const EVENT_UPGRADE_STOPPING_HARNESS = 'upgrade_stopping_harness';

const EVENT_SHELL_UPDATE_CHECKED = 'shell_update_checked';


const SYSTEMD_TEMPLATE_ASIDE_SUFFIX = '.disabled-by-lobox-';


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
  BRIDGE_MSG_KERNEL_UPDATE_REQUEST,
  BRIDGE_MSG_KERNEL_UPDATE_RESULT,
  BRIDGE_MSG_KERNEL_UPDATE_PROGRESS,
  STORE_KEY_API_ACCESS,
  COOKIE_LAN_TOKEN,
  EVENT_HARNESS_EXITED,
  EVENT_HARNESS_TOKEN_CAPTURED,
  EVENT_HARNESS_TOKEN_MISSING,
  EVENT_HARNESS_COMMAND_MISSING,
  EVENT_HARNESS_NOT_INSTALLED,
  EVENT_HARNESS_COMMAND_BOUND,
  EVENT_HARNESS_GUARDIAN_CHANGED,
  EVENT_HARNESS_REMOTE_CHANGED,
  EVENT_HARNESS_REMOTE_TOKEN_CHANGED,
  EVENT_LAN_HARNESS_TOKEN_UPDATED,
  EVENT_UPGRADE_STOPPING_HARNESS,
  EVENT_SHELL_UPDATE_CHECKED,
  SYSTEMD_TEMPLATE_ASIDE_SUFFIX,
  corePackageName,
  stateRoot,
  legacyStateRoot,
};
