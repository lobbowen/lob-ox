'use strict';

const os = require('node:os');
const path = require('node:path');

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
  probeIntervalMs: 5000,
  probeTimeoutMs: 3000,
  failThreshold: 2,
  httpProbeEnabled: true,
  startTimeoutMs: 30000,
  stopGraceMs: 10000,
  portReleaseWaitMs: 10000,
  crashWindowMs: 600000,
  crashBurst: 5,
  backoff: [30000, 60000, 120000, 300000, 600000],
  apiHost: '127.0.0.1',
  apiPort: 36360,
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

function normalize(raw, ext) {
  const extension = normalizeExtension(ext);
  const provided = raw || {};
  const cfg = Object.assign(buildDefaults(extension), provided);
  cfg.stateFile = expandHome(cfg.stateFile);
  cfg.logFile = expandHome(cfg.logFile);
  cfg.supervisorLogFile = expandHome(cfg.supervisorLogFile);
  cfg.dshLogFile = expandHome(cfg.dshLogFile);
  cfg.upgradeLogFile = expandHome(cfg.upgradeLogFile);
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
  cfg.probeTimeoutMs = Number.isFinite(Number(cfg.probeTimeoutMs)) && Number(cfg.probeTimeoutMs) > 0 ? Number(cfg.probeTimeoutMs) : 3000;
  cfg.failThreshold = Number.isInteger(Number(cfg.failThreshold)) && Number(cfg.failThreshold) >= 1 ? Number(cfg.failThreshold) : 2;
  cfg.httpProbeEnabled = cfg.httpProbeEnabled !== false;
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

module.exports = { DEFAULTS, BASE_DEFAULTS, buildDefaults, normalize, extractPortFromCommand };
