'use strict';

const stateRoot = require('../service/state-root');

// 平台抽象层：平台无关域（supervisor/domains/guard/api）不得直接触碰平台 API（systemctl/systemd-run/launchctl/
//   schtasks/notify-send/xdg-open/wmic/proc/netstat/lsof），一律经本门面；service 按 Provider 分派（见 service.js#current，
//   无单元 provider 不冒充），未实现能力抛 CapabilityError。能力矩阵 = capability-profile.js 静态档位 + 本文件 hasTool 实测覆写。

const os = require('node:os');
const path = require('node:path');
const ex = require('../util/exec');
const execPath = require('./exec-path');
// 图形会话可用性（只读 env/socket）：capabilities 的 openBrowser 位在 linux 上靠它实测覆写。
const desktop = require('./desktop');
// 档位数据在 ./capability-profile.js；门禁 cross-platform-architecture-gate CP-3 要求门面显式列出三平台分支。
const CAPABILITY_PROFILES = require('./capability-profile');
// 环境表单（探测事实的汇聚处）：能力矩阵由本门面在载入时注入，表单不得反向 require 本文件（成环）。
const environment = require('./environment');

const PLATFORM = process.platform; // 'linux' | 'darwin' | 'win32'
const ARCH = process.arch;

const isLinux = PLATFORM === 'linux';
const isMac = PLATFORM === 'darwin';
const isWindows = PLATFORM === 'win32';

// 工具可执行性探测（模块级缓存：capabilities 会被 API/UI 多次调用）。
// 正结果永久缓存；负结果只在 _NEG_TTL_MS 内有效 —— capabilities() 是 /env/status 的对外声明面，
// 启动早期 PATH 未就绪时若把缺工具记成永久 false，用户就再无恢复途径。
const _toolCache = {};
const _NEG_TTL_MS = 60000; // 负结果的重探窗口：既不过早翻案，也不让每次 /env/status 都实测一遍
function hasTool(name, args) {
  const hit = _toolCache[name];
  if (hit !== undefined) {
    if (hit === true) return true;
    if (Date.now() - (hit.at || 0) < _NEG_TTL_MS) return false;
  }
  // 存在性按解析判定、不执行：exec-path 解析（PATH+PATHEXT+标准落点）即「可被 spawn」的准确语义。
  // 不能用 `--version` 探存在性 —— taskkill/schtasks/osascript/powershell 无此约定（内建命令报错
  // 退出非零），据此谎报能力缺失会禁用面板的整树终止与自启；轮询路径也不该 spawn 第三方工具。
  if (execPath.resolveExecutable(name)) { _toolCache[name] = true; return true; }
  // 兜底实测（门禁 A3' 要求保留 runOut 形态）：解析器覆盖不到的 PATH 变体仍可经显式 args 实测。
  // 必须 runOut 而非 execFileSync：stdio ignore 下成功也返回 null，`!== null` 判存在会恒 false。
  const ok = ex.runOut(name, args || ['--version'], { timeoutMs: 3000 }) !== null;
  _toolCache[name] = ok ? true : { at: Date.now() };
  return ok;
}
/** DSH 数据目录：~/.dsh（被管控对象的数据，不属于本产品状态）。 */
function dataDir() {
  return path.join(os.homedir(), '.dsh');
}

/** 本产品状态目录（独立于 DSH）；单一事实源 = platform/service/state-root.js。 */
function supervisorDir() {
  return stateRoot.supervisorDir();
}

/** 平台静态能力档位（纯函数，无探测）：按平台取档位表，未知平台落 unknown 档而非抛错。
 *  工具类字段返回平台期望值，实测覆写发生在 capabilities()。
 *  @param platform 可选（默认 process.platform）
 *  @param arch 可选（默认 process.arch） */
function capabilityProfile(platform, arch) {
  const pl = platform || PLATFORM;
  const ar = arch || ARCH;
  const base = { platform: pl, arch: ar };
  if (pl === 'linux') return Object.assign(base, CAPABILITY_PROFILES.linux);
  if (pl === 'darwin') return Object.assign(base, CAPABILITY_PROFILES.darwin);
  if (pl === 'win32') return Object.assign(base, CAPABILITY_PROFILES.win32);
  return Object.assign(base, CAPABILITY_PROFILES.unknown);
}

/** 平台能力矩阵 = 静态档位 x 实际工具探测；供壳/面板做能力呈现与降级提示（/env/status）。 */
function capabilities() {
  const p = capabilityProfile();
  const pl = p.platform;
  if (pl === 'linux') {
    // W3：跑舱与 systemd-run 无关（缺它落 portable 软档）；实测只决定限额由谁执行。
    p.sandboxLaunch = true;
    p.sandboxEnforcement = hasTool('systemd-run') ? 'cgroup' : 'supervise';
    p.desktopNotify = hasTool('notify-send');
    p.autostart = hasTool('systemctl');
    // 外部打开要真判定：无图形会话时 xdg-open/浏览器必败（只读 env/socket 探测，零 spawn，
    // 与 desktopNotify 不同源是因为缺 notify-send 只影响提示、缺会话影响整条打开链路）。
    p.openBrowser = desktop.sessionAvailable();
  } else if (pl === 'darwin') {
    p.desktopNotify = hasTool('osascript');
  } else if (pl === 'win32') {
    p.processTreeKill = hasTool('taskkill');
    p.desktopNotify = hasTool('powershell');
    p.autostart = hasTool('schtasks');
  }
  return p;
}

// 环境表单的取数注入之一：表单要报「实测后的能力档位」，而带缓存的实测只住在本门面；
//   require 方向必须单向（门面 -> 表单），故此处把 getter 交出去而不是让表单来 require 门面。
environment.bind({ capabilities });

module.exports = {
  PLATFORM, ARCH, isLinux, isMac, isWindows,
  dataDir, supervisorDir, capabilities, capabilityProfile, hasTool,
  processControl: require('./process'),
  pidlookup: require('./pidlookup'),
  execPath,                         // 跨平台可执行解析
  fileProtect: require('./file-protect'), // 跨平台文件保护（Unix chmod / Windows icacls）
  service: require('./service'),          // 服务管理器抽象（Provider 分派）
  // notify 必须是直接可调函数：调用方按 platform.notify(title, body, onError) 用，
  // 导出模块对象会抛 platform.notify is not a function，把升级终态误判成失败。
  notify: require('./notify').notify,
  browser: require('./browser'),
  environment,                  // 环境表单（外部打开链路的事实底座 + 选路依据）
  desktop,                        // 图形会话可用性（Linux 需实测 socket）
  autostart: require('./autostart'),
};
