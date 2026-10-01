'use strict';

// 镜像源探测与选择（IO）：消费内存态的镜像配置与壳契约（载入/落盘在 registry-config.js），
// 回答「本次用哪个源、取不到时按什么顺序顺延、每个源为什么不行」。
// 状态由 DistributionManager 门面持有，本文件函数显式收参（state），不碰跨文件 this，
// 可独立 require 后传假 state 单测。

const matrix = require('../contract/matrix');
const policies = require('./policies');
const ref = require('./registry-ref');
const config = require('./registry-config');

/** 探测读取的字节上界。探测必须读完响应体而不是只看响应头：壳侧的测速读到结尾，
 *  一侧读一半、一侧读全就会两侧延迟不可比，「谁最快」的答案会分叉。 */
const PROBE_MAX_BODY_BYTES = 8 * 1024 * 1024;

/** 内核平台标签（用于展开契约的 pathTemplate）。平台知识收口到 platform/contract/matrix.js。 */
function platformTag() {
  return matrix.npmTag();
}

/** 探测单个 registry 的可达性 + 延迟（探测 URL 由契约决定，与壳同规格）。
 *  宿主不可产标 / 平台可产标但不在发布矩阵时退化为 ping 规格（tag=null 交 resolveProbe 守卫）：
 *  抛错会穿透选源 Promise.all，而探测恒 404 的包元数据会把全员判为不可达。
 *  传输走 ref.fetchRegistry，与取包元数据同一条路，故「探测可达」与「取到字节」不会给出不同答案。
 *  响应体读满而非只看状态码：壳的测速读到结尾，一侧读一半则两侧延迟不可比。 */
async function probeRegistry(state, origin) {
  const spec = (state.contract && state.contract.ok && state.contract.probe) || null;
  let tag = null;
  try {
    if (matrix.isSupported()) tag = platformTag();
  } catch { tag = null; }
  const target = policies.resolveProbe(origin, spec, tag);
  if (!target.url) {
    return { ok: false, latencyMs: 0, probe: target.kind, error: target.violation || '镜像基址非法' };
  }
  const start = Date.now();
  const r = await ref.fetchRegistry(target.url, {
    timeoutMs: target.timeoutMs, expect: 'text', maxBytes: PROBE_MAX_BODY_BYTES,
  });
  return { ok: !!r.ok, latencyMs: Date.now() - start, probe: target.kind, error: r.error || null };
}

/** 探测单个 origin 的可达性与延迟（供面板「测试」按钮与选源共用）。基址非法时如实回拒因。 */
async function probeOrigin(state, origin) {
  const parsed = ref.parseRegistryBase(origin);
  if (!parsed.ok) return { origin: ref.normalizeBase(origin), ok: false, latencyMs: null, error: parsed.violation };
  const p = await probeRegistry(state, parsed.base);
  return { origin: parsed.base, ok: !!p.ok, latencyMs: p.latencyMs, probe: p.probe, error: p.error || null };
}

function registryOrigins(state) {
  const seen = new Set();
  const out = [];
  for (const raw of policies.effectiveOrigins(state.registryConfig, state.contract, state.defaultRegistries)) {
    const parsed = ref.parseRegistryBase(raw);
    const base = parsed.ok ? parsed.base : ref.normalizeBase(raw);
    if (seen.has(base)) continue;
    seen.add(base);
    out.push(base);
  }
  return out;
}

/** 一次测速：并发探全部候选，返回按「可达优先、延迟升序」排序的序列与逐源结论。 */
async function probeAllOrigins(state, origins) {
  const results = await Promise.all(origins.map(async (origin) => {
    const p = await probeRegistry(state, origin);
    return { origin, ok: !!p.ok, latencyMs: p.latencyMs, error: p.error || null };
  }));
  results.sort((a, b) => (a.ok === b.ok ? a.latencyMs - b.latencyMs : (a.ok ? -1 : 1)));
  return results;
}

/** 逐源结论优先采用壳投放的测速证据（与内核同一探测规格、同一轮测完）：命中就省掉一次全量网络
 *  往返，面板首屏不用转圈。采用条件由 policies.shellProbeResults 把关（新鲜 + 覆盖全部候选 +
 *  逐源过形态闸），任何一条不满足就回退自测 —— 自测才是真相，证据只是加速。 */
async function probeOrAdopt(state, origins) {
  const c = state.contract;
  if (c && c.ok) {
    const adopted = policies.shellProbeResults(origins, c.measurements, Math.floor(Date.now() / 1000));
    if (adopted) return adopted;
  }
  return probeAllOrigins(state, origins);
}

/** 排成消费序列：primary 第一，其余按延迟，非法基址一律不入选。
 *  primary 是「本次该用的那一个」，序列是「取不到时顺延的顺序」—— 两者必须同源，
 *  否则面板显示的源和实际下载的源会再次分叉。 */
function orderFor(primary, origins, results) {
  const usable = (o) => ref.parseRegistryBase(o).ok;
  const ranked = (results || []).filter((r) => r.ok).map((r) => r.origin);
  const ordered = [];
  for (const o of [primary, ...ranked, ...origins]) {
    if (!o || !usable(o)) continue;
    if (!ordered.includes(o)) ordered.push(o);
  }
  return ordered;
}

/** 选源。返回 {origin, ordered, source, manual, probes}：origin=本次用的一个（全不可达时取候选首位
 *  并留下探测结论，交消费阶段顺延），ordered=消费阶段按序尝试的候选，probes=逐源结论（必须保留，
 *  「不可达」要能指名是哪个源、为什么）。source 取值 manual | shell-probe | probe | unreachable。
 *  manual 语义是「置顶这一个，仍测速、仍回退」，否则固定成死源后拿不到任何诊断。 */
async function selectRegistry(state, force) {
  // 契约与选择文档都要能重载：壳会在运行中重写 registry.json（catalog/probe/measurements），面板
  //   也会改 mode/手动源。内核进程若只看启动瞬间的状态，会出现「两侧选源不一致」与「手动设了不生效」。
  config.reloadContractIfStale(state);
  const rc = state.registryConfig || {};
  const origins = registryOrigins(state);
  const manualParsed = ref.parseRegistryBase(rc.manualOrigin);
  const manualBase = manualParsed.ok ? manualParsed.base : '';
  const manual = rc.mode === 'manual' && !!manualBase;

  const now = Date.now();
  const cached = state.selectedRegistry;
  // manual 同样享缓存：它的语义已是「置顶但仍测速」，不复用结果就等于每次读面板都全源重测。
  // 配置写入路径会清空 selectedRegistry，因此「改了手动源却看不到」不会由本行带回。
  if (!force && cached && cached.checkedAt && (now - cached.checkedAt) < 30 * 60 * 1000) {
    return cached;
  }
  const results = await probeOrAdopt(state, origins);
  const firstReachable = results.find((r) => r.ok);
  const fromShell = results.length > 0 && results.every((r) => r.from === 'shell-contract');
  const primary = manual ? manualBase : ((firstReachable && firstReachable.origin) || null);
  const selected = {
    origin: primary,
    ordered: orderFor(primary, origins, results),
    source: manual ? 'manual' : (firstReachable ? (fromShell ? 'shell-probe' : 'probe') : 'unreachable'),
    manual,
    checkedAt: firstReachable || manual ? now : null, // 全不可达不缓存坏选择：下次调用仍会重测
    latencyMs: (firstReachable && firstReachable.origin === primary) ? firstReachable.latencyMs : null,
    probes: results,
  };
  state.selectedRegistry = selected;
  if (state.events) {
    try {
      state.events.append(firstReachable || manual ? 'dist_registry_selected' : 'dist_registry_unreachable', {
        origin: primary,
        source: selected.source,
        candidates: results.map((r) => r.origin + ':' + (r.ok ? r.latencyMs + 'ms' : (r.error || '不可达'))),
      });
    } catch { /* 事件失败不阻断 */ }
  }
  return selected;
}

/** 主镜像基址：只要「本次用哪个源」的调用方走这里（安装/下载/env 注入）。
 *  需要顺延序列或逐源失败原因的调用方走 selectRegistry。 */
async function registryOrigin(state, force) {
  const sel = await selectRegistry(state, force);
  return (sel && sel.origin) || null;
}

/** 镜像源信息（供 UI/API 展示）。origin/candidates/probes 既有键语义不变，另有 ordered（消费顺延序列）/
 *  source（本次选择依据）/ registries（逐源形态与判定结论）。 */
async function registryInfo(state) {
  config.reloadContractIfStale(state);
  const sel = await selectRegistry(state, false) || {};
  const rc = state.registryConfig || {};
  const c = state.contract;
  const verdictOf = (origin) => (sel.probes || []).find((p) => p.origin === origin) || null;
  return {
    origin: sel.origin || null,
    ordered: sel.ordered || [],
    source: sel.source || null,
    mode: rc.mode || 'auto',
    manualOrigin: rc.manualOrigin || '',
    candidates: registryOrigins(state).map((o) => ({ origin: o })),
    registries: registryOrigins(state).map((o) => {
      const parsed = ref.parseRegistryBase(o);
      const v = verdictOf(o);
      return {
        base: parsed.base,
        usable: parsed.ok,
        violation: parsed.violation,
        reachable: v ? v.ok : null,
        latencyMs: v ? v.latencyMs : null,
        error: v ? (v.error || null) : null,
      };
    }),
    // 预设 = 壳投放的目录；契约不可用时为空数组，UI 应展示 candidates。
    presets: (c && c.ok) ? c.catalog : [],
    catalogSource: (c && c.ok) ? (c.writtenBy || 'shell') : 'fallback',
    // 契约 schema 必须可见：v2（选择字段还在契约里）与 v3（各写各的文件）在诊断时是两回事。
    contractSchema: (c && c.ok) ? c.schema : null,
    latencyMs: sel.latencyMs || null,
    checkedAt: sel.checkedAt || null,
    manual: !!sel.manual,
    probes: sel.probes || [],
  };
}

/** 保存全局镜像源配置（mode/手动源/候选）并立即重测。写入口闸：manualOrigin 与每条 origins 都过
 *  policies.registryOriginViolation（形态闸 + 私网主机闸，比探测端点严——探测端点反向豁免已配置源）；
 *  过不了的字面量不落盘，拒因经 error/errors 回传；auto 模式不预校验 manualOrigin（此刻不参与选源）。
 *  rc 是 registryConfig 的副本、全部校验通过才回写 state：若在原对象上先落 mode 再校验，
 *  被拒的「切 manual + 私网源」会造成内存/磁盘分叉且下次重测走旧手动源。 */
async function setRegistryConfig(state, cfg) {
  const rc = { ...(state.registryConfig || {}) };
  let rejected = [];
  if (cfg && typeof cfg === 'object') {
    if (cfg.mode === 'manual' || cfg.mode === 'auto') rc.mode = cfg.mode;
    if (typeof cfg.manualOrigin === 'string') {
      const mo = cfg.manualOrigin.trim();
      // 仅「切到 manual 且要落手动源」时强校验；清空（''）沿用旧语义放行（选源侧自会回退）。
      if (mo && rc.mode === 'manual') {
        const v = policies.registryOriginViolation(mo);
        if (v) {
          const info = await registryInfo(state); // 不改配置，回当前实况 + 拒因
          info.error = v;
          return info;
        }
      }
      rc.manualOrigin = mo;
    }
    if (Array.isArray(cfg.origins)) {
      const raw = cfg.origins.map((x) => String(x).trim());
      // 非法项不得静默丢弃（用户改镜像源却不知道哪条被拒）：拒因含格式非法与 SSRF
      // 主机字面量违规两类，统一收集后经日志与返回值暴露。
      const reasons = new Map();
      const list = raw.filter((x) => {
        if (!x) return false;
        const v = policies.registryOriginViolation(x);
        if (v) { reasons.set(x, v); return false; }
        return true;
      });
      rejected = raw.filter((x) => x && reasons.has(x));
      if (list.length) rc.origins = list; // 全部非法时保留既有 origins（不写成空）
    }
  }
  state.registryConfig = rc;
  config.saveRegistryConfig(state);
  state.selectedRegistry = null; // 清缓存，立即重测
  const info = await registryInfo(state);
  if (rejected.length) {
    if (state.logger && state.logger.warn) {
      state.logger.warn('[registry] 已忽略 ' + rejected.length + ' 个非法镜像源（需 http(s):// 前缀）：' +
        rejected.slice(0, 3).join(', ') + (rejected.length > 3 ? ' …' : ''));
    }
    info.rejectedOrigins = rejected; // 调用方（/dist/registry）直接回传本对象，UI 可见
  }
  return info;
}

module.exports = {
  platformTag,
  probeRegistry,
  probeOrigin,
  probeAllOrigins,
  registryOrigins,
  orderFor,
  selectRegistry,
  registryOrigin,
  registryInfo,
  setRegistryConfig,
};
