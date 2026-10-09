'use strict';

const os = require('node:os');
const path = require('node:path');
const SHARED = require('../../shared/shared-constants');


function expandHome(p) {
  if (typeof p !== 'string') return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

const SUP = require('./state-root').supervisorDir();

const NO_EXTENSION = Object.freeze({ defaults: [], aliases: [] });

function normalizeExtension(ext) {
  if (!ext || typeof ext !== 'object') return NO_EXTENSION;
  return {
    defaults: Array.isArray(ext.defaults) ? ext.defaults : [],
    aliases: Array.isArray(ext.aliases) ? ext.aliases : [],
  };
}

const BASE_DEFAULTS = {
  // 守卫监控节拍（进程存活只由 child 的 exit/close 事件与平台 pidlookup 判定，见 app/main/*）。
  tickIntervalMs: 5000,
  // 启动窗口（秒）：spawn 后 startsecs 内退出 ⇒ 记一次「启动失败」；活过 startsecs 后退出 ⇒ 正常重启，不计失败。
  startsecs: 10,
  // 唯一一条限流：startupFailWindowMs 内「启动失败」达 startupFailBurst 次 ⇒ phase=FAILED，停止自动重启，等人工重试。
  // 不变量：startupFailWindowMs > startupFailBurst × startsecs×1000（60s > 5×10s）；同一规则按域参数化，实例域见 domains/instance/state-machine.js。
  startupFailWindowMs: 60000,
  startupFailBurst: 5,
  stopGraceMs: 10000,
  portReleaseWaitMs: 10000,
  apiHost: '127.0.0.1',
  apiPort: SHARED.net.apiPort,
  portPools: null,
  stateFile: path.join(SUP, 'state.json'),
  logFile: path.join(SUP, 'events', 'guard.events.log'),
  eventsMaxBytes: 5 * 1024 * 1024,
  supervisorLogFile: path.join(SUP, 'log', 'guard.log'),
  dshLogFile: path.join(SUP, 'log', 'dsh.log'),
  upgradeLogFile: path.join(SUP, 'log', 'upgrade.log'),
  logLevel: 'info',
  logMaxBytes: 5 * 1024 * 1024,
  notifyEnabled: true,
  corePackageName: null,
  pluginsProfileName: 'web',
  packageName: '@deepseek-ai/dsh',
  canary: false,
  registries: [
    'https://registry.npmjs.org',
    'https://registry.npmmirror.com',
  ],
  updateCheckEnabled: true,
  updateCheckIntervalMs: 3600000,
  initialCheckDelayMs: 20000,
  upgradeTimeoutMs: 600000,
  installCommandTemplate: ['npm', 'install', '-g', '{pkg}@{version}'],
  // apiAccessKey：非回环须带 Authorization: Bearer <key> 或 ?access_key=<key>，回环豁免；不配置则 LAN 受 RFC1918 约束、FRP 仍强制 remoteToken。
  apiAccessKey: null,
  closeAction: 'hide',
  externalBrowser: null,
};

function buildDefaults(ext) {
  const pending = normalizeExtension(ext).defaults.slice();
  const out = {};
  for (const key of Object.keys(BASE_DEFAULTS)) {
    for (let i = pending.length - 1; i >= 0; i--) {
      const g = pending[i];
      if (g && g.at === key) {
        if (g.values && typeof g.values === 'object') Object.assign(out, g.values);
        pending.splice(i, 1);
      }
    }
    out[key] = BASE_DEFAULTS[key];
  }
  for (const g of pending) {
    if (g && g.values && typeof g.values === 'object') Object.assign(out, g.values);
  }
  return out;
}

const DEFAULTS = buildDefaults(null);

// 已弃用的**落盘值**：在线更新只换二进制，状态根不动 ⇒ 旧版写入的值会一直生效。
// 实证：apiPort=36360 跨三个版本从未更新（老产品守卫常驻该端口 ⇒ 新产品守卫永不起来）。
// 故 normalize 必须**用默认值覆盖弃用值**，而不是无脑信任落盘值 —— 否则默认值改了也对存量用户无效。
// 与壳侧同源：现在两侧都从 shared-constants.json 取（不再是"两份常量 + 门禁对账"，而是单一来源）。
const DEPRECATED_API_PORTS = SHARED.net.deprecatedApiPorts.slice();

function isDeprecatedApiPort(v) {
  const n = Number(v);
  return Number.isInteger(n) && DEPRECATED_API_PORTS.includes(n);
}

function normalize(raw, ext) {
  const extension = normalizeExtension(ext);
  const provided = raw || {};
  const cfg = Object.assign(buildDefaults(extension), provided);
  // 弃用值覆盖：落盘值已弃用 ⇒ 退回默认值。
  // 判据只看 provided（落盘值）—— assign 之后 cfg.apiPort 已被落盘值覆盖，
  // 再拿 cfg 判"默认值是否弃用"恒为假（这正是本条修掉的自反写法）。
  if (isDeprecatedApiPort(provided.apiPort)) {
    cfg.apiPort = BASE_DEFAULTS.apiPort;
    cfg.__deprecatedOverridden = (cfg.__deprecatedOverridden || []).concat(['apiPort']);
  }
  cfg.stateFile = expandHome(cfg.stateFile);
  cfg.logFile = expandHome(cfg.logFile);
  cfg.supervisorLogFile = expandHome(cfg.supervisorLogFile);
  cfg.dshLogFile = expandHome(cfg.dshLogFile);
  cfg.upgradeLogFile = expandHome(cfg.upgradeLogFile);
  // healthUrl 不再作为健康探测目标：它只用来派生 targetHost/targetPort（面板地址与端口占用判定）。
  let u;
  try {
    u = new URL(cfg.healthUrl);
  } catch {
    throw new Error('config.healthUrl 无效: ' + JSON.stringify(cfg.healthUrl));
  }
  cfg.targetHost = u.hostname;
  cfg.targetPort = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
  for (const [from, to] of extension.aliases) {
    if (provided[to] === undefined && provided[from] !== undefined) cfg[to] = provided[from] === true;
  }
  const cmdPort = extractPortFromCommand(cfg.command);
  if (cmdPort !== null) cfg.targetPort = cmdPort;
  // 不变量：healthUrl 端口必须等于 targetPort（真实 spawn 端口），否则以 targetPort 校正。
  // port-rederive 改端口时同步写两者，反证二者本应恒等；此前无人强制 ⇒ 升级可能等错端口。
  if (u.port && Number(u.port) !== cfg.targetPort) { u.port = String(cfg.targetPort); cfg.healthUrl = u.toString(); }
  cfg.tickIntervalMs = Number(cfg.tickIntervalMs) > 0 ? Number(cfg.tickIntervalMs) : 5000;
  cfg.startsecs = Number(cfg.startsecs) > 0 ? Number(cfg.startsecs) : 10;
  cfg.startupFailWindowMs = Number(cfg.startupFailWindowMs) > 0 ? Number(cfg.startupFailWindowMs) : 60000;
  cfg.startupFailBurst = Number.isInteger(Number(cfg.startupFailBurst)) && Number(cfg.startupFailBurst) >= 1
    ? Number(cfg.startupFailBurst) : 5;
  if (!Array.isArray(cfg.command) || cfg.command.length === 0) {
    throw new Error('config.command 缺失：需要一个命令数组');
  }
  return cfg;
}

function extractPortFromCommand(command) {
  if (!Array.isArray(command)) return null;
  for (let i = 0; i < command.length; i++) {
    const a = String(command[i]);
    if ((a === '--port' || a === '-p') && i + 1 < command.length) {
      const n = Number(command[i + 1]);
      if (Number.isInteger(n) && n > 0 && n <= 65535) return n;
    }
    const m = /^--port=(\d+)$/.exec(a);
    if (m) { const n = Number(m[1]); if (Number.isInteger(n) && n > 0 && n <= 65535) return n; }
  }
  return null;
}

module.exports = { DEFAULTS, BASE_DEFAULTS, buildDefaults, normalize, extractPortFromCommand,
  DEPRECATED_API_PORTS, isDeprecatedApiPort };
