'use strict';

// 配置地基：默认值 + 归一化，纯函数无副作用。守卫配置从 config.json 读取，经 normalize 校验并铺平。

const os = require('node:os');
const path = require('node:path');

function expandHome(p) {
  if (typeof p !== 'string') return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

// 产品状态根（独立于 DSH 的 ~/.dsh）——单一事实源 = platform/service/state-root.js。
// 进程内固定：避免运行中环境变化导致状态目录半途切换。
const SUP = require('./state-root').supervisorDir();

// 业务域配置键是注入点（反转法）：平台源码不得出现业务配置键字面量（结构门禁 DS-G4 判违规），
// 默认值与别名由装配期从 app/settings/domain-config.js 注入，形态
// { defaults: [ { at: 锚点键, values: {...} } ], aliases: [ [旧键, 新键] ] }。
// 不静态 require app（会成环，DS-1/DS-G2）；未注入时 normalize 不含业务键，消费点自带兜底。
const NO_EXTENSION = Object.freeze({ defaults: [], aliases: [] });

/** 规范化外部注入声明；非法/缺省即空注入（不追加任何业务键）。 */
function normalizeExtension(ext) {
  if (!ext || typeof ext !== 'object') return NO_EXTENSION;
  return {
    defaults: Array.isArray(ext.defaults) ? ext.defaults : [],
    aliases: Array.isArray(ext.aliases) ? ext.aliases : [],
  };
}

/** 平台通用默认值（此对象不得含任何业务域键 —— DS-G4）。 */
const BASE_DEFAULTS = {
  probeIntervalMs: 5000,
  // 健康探测三层：L0 进程存活 + L1 端口监听 + L2 HTTP GET healthUrl。probeTimeoutMs = 单次探测超时；
  // failThreshold = 连续失败判故障（防抖动）；httpProbeEnabled=false 退化为端口在线即健康。
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
  // API 端口：高位不常用段起始（常用端口段易冲突）；守卫启动被占则自动顺延并持久化。
  apiPort: 36360,
  // 注意：daemon 控制通道端口属业务域知识，经注入声明提供（同上），原键名与值逐字保留。
  // 动态端口池（范围是配置项，非编译期常量）：null = 内置默认池，默认避开 OS 动态端口范围
  // （Linux ip_local_port_range=32768-60999），落在 IANA User 段低位。额外池由域装配期申报（DS-G4）。
  portPools: null,
  stateFile: path.join(SUP, 'state.json'),
  // 日志目录布局：事件在 events/guard.events.log，分级日志在 log/；显式配置的路径尊重用户给定值，不强改。
  logFile: path.join(SUP, 'events', 'guard.events.log'),
  eventsMaxBytes: 5 * 1024 * 1024,
  supervisorLogFile: path.join(SUP, 'log', 'guard.log'),
  dshLogFile: path.join(SUP, 'log', 'dsh.log'),
  upgradeLogFile: path.join(SUP, 'log', 'upgrade.log'),
  logLevel: 'info',
  logMaxBytes: 5 * 1024 * 1024,
  notifyEnabled: true,
  // 内核更新单写入者 = 桌面壳：corePackageName 仅为内核自身 npm 子包名，守卫只读它查版本状态，
  // 安装/升级由壳执行。不得再引入 manifest 更新通道（残留键已删，config.json 中未知键加载时忽略）。
  corePackageName: null,
  pluginsProfileName: 'web',
  packageName: '@deepseek-ai/dsh',
  // 灰度名单（RELEASE-CHANNEL-CONTRACT）：本机 canary:true 即灰度机，仅对内核包生效，对第三方包
  // （packageName）无效；未置真即非灰度。
  canary: false,
  // 最小兜底镜像源（不变量 C2）：完整目录归壳管理，经 <产品状态根>/supervisor/registry.json 投放，
  // 内核由 platform/distribution 读取（契约见 platform/contract/registry.js）；
  // 此处官方源 + npmmirror 两条兜底，保证契约不可用时仍可安装。
  registries: [
    'https://registry.npmjs.org',
    'https://registry.npmmirror.com',
  ],
  updateCheckEnabled: true,
  updateCheckIntervalMs: 3600000,
  initialCheckDelayMs: 20000,
  upgradeTimeoutMs: 600000,
  installCommandTemplate: ['npm', 'install', '-g', '{pkg}@{version}'],
  // apiAccessKey（可选）出回环访问密钥：配置后，0.0.0.0（局域网）与 FRP 公网通道的 API 请求必须携带
  // Authorization: Bearer <key> 或 ?access_key=<key>，否则 401；回环豁免。
  // 不配置 = LAN 受 RFC1918 白名单约束，FRP 暴露仍强制 remoteToken。
  apiAccessKey: null,
  // 关闭窗口行为（系统级）：'hide' = 隐藏至托盘、服务常驻（默认）；'exit' = 退出管家并停全部服务链。
  closeAction: 'hide',
  // 外部打开的浏览器偏好（系统级，本机配置）：存环境表单候选清单里的 id，null = 未选。
  // 与「系统默认浏览器」分两个字段是刻意的：前者是用户在本产品里的选择，后者是操作系统的事实；
  // 系统说不出默认时按候选次序分发并如实标注，用户可在这里定一次覆盖它（见 platform/os/environment.js）。
  externalBrowser: null,
};

/** 合并注入的业务域默认值 + 平台通用默认值。注入组的 at 是锚点键：该组的值落在 BASE_DEFAULTS
 *  此键之前，使完整 DEFAULTS 的键序固定不变（launcher 落盘模板无字节漂移）。
 *  锚点未命中则追加末尾（绝不丢键）；同名键以平台侧为准。 */
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

/** 模块级默认值 = 无业务键的平台默认值；需业务键（如 launcher 落盘模板）用 buildDefaults(注入声明)。 */
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
  // healthUrl 非法直接 fail-fast（静默降级会让探测永远失败且难排查）
  let u;
  try {
    u = new URL(cfg.healthUrl);
  } catch {
    throw new Error('config.healthUrl 无效: ' + JSON.stringify(cfg.healthUrl));
  }
  cfg.targetHost = u.hostname;
  cfg.targetPort = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
  // 配置键迁移：换名别名由注入声明提供。语义：别名仅在新键未给且旧键已给时生效，布尔归一严格 === true。
  // 判 provided（raw）而非 cfg：DEFAULTS 已填新键默认值，判 cfg 会让分支恒死（历史 RC6 缺陷）。
  for (const [from, to] of extension.aliases) {
    if (provided[to] === undefined && provided[from] !== undefined) cfg[to] = provided[from] === true;
  }
  // 动态端口注册：command 里的 --port/-p 是 DSH 实际启动参数，若指定则以它为准覆盖 healthUrl 端口。
  const cmdPort = extractPortFromCommand(cfg.command);
  if (cmdPort !== null) cfg.targetPort = cmdPort;
  // 健康维度参数归一化：非法值回退默认，杜绝 NaN/负数进入探测链路
  cfg.probeTimeoutMs = Number.isFinite(Number(cfg.probeTimeoutMs)) && Number(cfg.probeTimeoutMs) > 0 ? Number(cfg.probeTimeoutMs) : 3000;
  cfg.failThreshold = Number.isInteger(Number(cfg.failThreshold)) && Number(cfg.failThreshold) >= 1 ? Number(cfg.failThreshold) : 2;
  cfg.httpProbeEnabled = cfg.httpProbeEnabled !== false;
  if (!Array.isArray(cfg.command) || cfg.command.length === 0) {
    throw new Error('config.command 缺失：需要一个命令数组');
  }
  return cfg;
}

/** 从启动命令提取端口（--port N / -p N）；无则返回 null。 */
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

// extractPortFromCommand 供 supervisor 运行期端口再推导复用（同一实现防重复）；BASE_DEFAULTS/buildDefaults
// 供入口取含业务键的完整默认值。
module.exports = { DEFAULTS, BASE_DEFAULTS, buildDefaults, normalize, extractPortFromCommand };
