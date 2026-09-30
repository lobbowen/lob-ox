'use strict';

// 分发域的纯策略（无 IO）：镜像合法性、契约/配置合并、探测规格展开、选源决策。
// 全部为具名纯函数，入参显式，可独立 require 单测。

// SSRF 主机分级与镜像基址形态都在 registry-ref 单一定义，本文件只做纯策略的组合与文案。
const registryRef = require('./registry-ref');

/** npm 子进程动作的时长预算（毫秒）。两处最坏情形不同，故分开定量、不再各写一个字面量：
 *  安装受 registry 往返支配；卸载只删本地 node_modules，卡住的原因是网络盘/杀软扫描，
 *  量级与 Rust 侧 npm 上限（15min）对齐。调用方可用 config 覆盖（测试与慢盘环境）。 */
const NPM_TIMEOUT_MS = { install: 600000, uninstall: 900000 };

/** 最小兜底镜像源——仅契约缺失/损坏时使用，不参与正常选择路径（不变量 C2 的兜底）。
 *  完整目录与探测规格归壳（经 registry.json 的 catalog 投放）。保留 2 条覆盖两种基本
 *  情形：能上公网（官方）/ 中国网络（npmmirror）。 */
const FALLBACK_REGISTRIES = [
  'https://registry.npmjs.org',
  'https://registry.npmmirror.com',
];

/** 写入口镜像源闸：形态闸（registry-ref）+ 私网主机闸。镜像源是唯一能进内核 fetch 与 npm
 *  下载链的外部地址，落盘即等于把内核指向内网/元数据地址，所以这一层必须比消费闸严；
 *  探测端点（api/domains/dist.js 的 probeTargetError）对**已配置** hostname 反向豁免，分工不同。
 *  @returns {string|null} 拒因；null=放行 */
function registryOriginViolation(origin) {
  const parsed = registryRef.parseRegistryBase(origin);
  if (!parsed.ok) return parsed.violation;
  return registryRef.hostViolation(parsed.host);
}

/** 生效的候选 registry 列表（纯）。顺序即所有权：
 *  1) 内核选择文档里的 origins —— 用户在面板里显式维护的候选，最该被尊重；
 *  2) 契约 catalog —— 壳投放的「这台机器上验证过的镜像目录」；
 *  3) defaultRegistries —— 兜底（构造参数，缺省即最小兜底）。
 *  把目录排在用户之前会让候选编辑在壳下次重写契约时静默失效，所以这一版按上面的顺序取第一个非空。 */
function effectiveOrigins(registryConfig, contract, defaultRegistries) {
  const user = ((registryConfig && registryConfig.origins) || [])
    .filter((x) => typeof x === 'string' && x.trim());
  if (user.length) return user;
  const catalog = (contract && contract.ok && contract.catalog.length) ? contract.catalog : [];
  if (catalog.length) return catalog;
  return [...(defaultRegistries || [])];
}

/** 由内核自持的选择文档重建内存态（纯）。这份文档只有内核写，所以不再需要「读回原文档保留壳字段」
 *  的义务；缺失字段按默认值：auto + 不固定手动源 + 空候选（候选来自契约目录）。
 *  @param {object} [doc] 选择文档；null/损坏由调用方处理 */
function rebuildRegistryConfig(doc) {
  const d = (doc && typeof doc === 'object' && !Array.isArray(doc)) ? doc : {};
  const origins = Array.isArray(d.origins) ? d.origins.filter((x) => typeof x === 'string' && x.trim()) : [];
  return {
    mode: d.mode === 'manual' ? 'manual' : 'auto',
    manualOrigin: typeof d.manualOrigin === 'string' ? d.manualOrigin.trim() : '',
    origins,
  };
}

/** 展开单个镜像的探测目标。契约 probe.kind='package-metadata' 且有 platformTag 时用与壳完全一致的真实包元数据 URL，否则退化为 `/-/ping`
 *  （实测两种规格延迟差数倍，两侧必须同规格，否则「面板显示一个源、实际下载用另一个」分叉）。
 *  platformTag 为 null/空（宿主不可产标或不在发布矩阵，调用方 probeRegistry 已判定）时必须退化 —— 缺守卫会把字面量 `undefined` 拼进 pathTemplate 恒 404。
 *  基址非法时返回 url:null + violation，由调用方按「该源不可用」如实记录，而不是拼出一个必败 URL。 */
function resolveProbe(origin, spec, platformTag) {
  const timeoutMs = (spec && Number.isFinite(spec.timeoutMs) && spec.timeoutMs > 0) ? spec.timeoutMs : 4000;
  const parsed = registryRef.parseRegistryBase(origin);
  if (!parsed.ok) return { url: null, kind: 'invalid', timeoutMs, violation: parsed.violation };
  if (spec && spec.kind === 'package-metadata' && spec.pathTemplate && platformTag) {
    return {
      url: registryRef.registryUrl(parsed.base, spec.pathTemplate.replace('{platform}', platformTag)),
      kind: spec.kind,
      timeoutMs,
    };
  }
  return { url: registryRef.registryUrl(parsed.base, '/-/ping'), kind: 'ping', timeoutMs };
}

/** 本机是否在灰度名单内。冻结语义是「读名单包内容 + schema===1 + installId/hostnames 匹配」；
 *  该包尚未发布（预留），故当前只认本地开关 `canary === true`。
 *  注意：不得以「名单包存在」为依据——名单包为全部候选机共用，装了就全员灰度。 */
function isInCanaryList(state) {
  return state.canary === true;
}

/** 壳测速证据的可采用时长（秒）。与内核自身选源缓存同量级：过期即自己重测，因为「上次谁最快」
 *  不等于「现在谁最快」；而窗口内的重复全量测速会让面板白等一轮网络往返。 */
const SHELL_PROBE_MAX_AGE_SEC = 30 * 60;

/** 把壳投放的测速证据折成内核的逐源结论（纯），返回形状与 probeAllOrigins 一致，或 null 表示
 *  不能用（无证据 / 过期 / **未覆盖本轮全部候选**）。最后一条是采用它的全部理由：只有全覆盖时
 *  「信壳测过」才等于「自己不用再测」，缺一个源就下结论会把面板的逐源卡变成半空。
 *  采用前仍逐条过形态闸：证据来自文件，且壳的目录形态可能比本内核宽。 */
function shellProbeResults(origins, measurements, nowSec, maxAgeSec) {
  if (!Array.isArray(measurements) || !measurements.length) return null;
  const ttl = Number.isFinite(maxAgeSec) ? maxAgeSec : SHELL_PROBE_MAX_AGE_SEC;
  const byBase = new Map();
  for (const m of measurements) {
    if (!m || typeof m.origin !== 'string') continue;
    const age = nowSec - Number(m.checkedAt);
    if (!(age >= 0) || age > ttl) continue;
    const parsed = registryRef.parseRegistryBase(m.origin);
    if (parsed.ok && !byBase.has(parsed.base)) byBase.set(parsed.base, m);
  }
  if (!byBase.size) return null;
  const results = [];
  for (const o of origins || []) {
    const parsed = registryRef.parseRegistryBase(o);
    // 候选本身过不了形态闸时**不采用**而不是跳过：跳过等于宣称「壳测过了这一轮的全部候选」，
    // 而那个候选根本没被比过 —— 面板会少一格源卡且无人报错。回退自测才会给它自己的拒因。
    if (!parsed.ok) return null;
    const m = byBase.get(parsed.base);
    if (!m) return null;
    results.push({
      origin: parsed.base,
      ok: m.ok === true,
      latencyMs: Number.isFinite(m.latencyMs) ? m.latencyMs : 0,
      error: m.error || null,
      from: 'shell-contract',
    });
  }
  if (!results.length) return null;
  results.sort((a, b) => (a.ok === b.ok ? a.latencyMs - b.latencyMs : (a.ok ? -1 : 1)));
  return results;
}

module.exports = {
  FALLBACK_REGISTRIES,
  NPM_TIMEOUT_MS,
  SHELL_PROBE_MAX_AGE_SEC,
  registryOriginViolation,
  effectiveOrigins,
  rebuildRegistryConfig,
  resolveProbe,
  shellProbeResults,
  isInCanaryList,
};
