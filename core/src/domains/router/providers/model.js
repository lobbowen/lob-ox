'use strict';

// 账号模型：结构、keyId、状态字段、序列化形状。纯模块，零 IO。

const crypto = require('node:crypto');

/** 账号指纹（keyId）：sha256 前 10 位 + 尾 4 位（可读且不可逆）。 */
function keyFingerprint(k) {
  if (!k) return 'unknown';
  const hash = crypto.createHash('sha256').update(String(k)).digest('hex').slice(0, 10);
  return hash + '…' + String(k).slice(-4);
}

/** 展示用掩码（日志/面板安全形态：绝不输出完整 key）。 */
function maskKey(k) {
  if (!k || String(k).length <= 8) return '***';
  return '...' + String(k).slice(-6);
}

/** 账号构造唯一入口（直连/反代共用），产出规范化入库对象。 */
function accountModel(key, extra) {
  return {
    key,
    keyId: keyFingerprint(key),
    maskedKey: maskKey(key),
    status: 'registering',
    quota: null,
    registeredAt: Date.now(),
    ...(extra || {}),
  };
}

/** 单账号序列化形状（落盘字段唯一事实源：只写 status，不写 validity/usage 派生字段）。 */
function serializeAccount(a) {
  return {
    key: a.key,
    keyId: a.keyId,
    maskedKey: a.maskedKey,
    status: a.status || 'registered',
    quota: a.quota || null,
    registeredAt: a.registeredAt,
    detectError: a.detectError || null,
    nextResetAt: a.nextResetAt || null,
    limit: a.limit || null,
    lastProbeAt: a.lastProbeAt || null,
    lastProbeError: a.lastProbeError || null,
  };
}

/** 供应商预设（厂商目录，非账号状态）。 */
const PROVIDER_PRESETS = [
  {
    id: 'opencode-zen',
    name: 'OpenCode Zen (Go)',
    baseUrl: 'https://opencode.ai/zen/go/v1',
    plan: { per5hUsd: 12, weeklyUsd: 30, monthlyUsd: 60 },
    adapter: {
      quota: { type: 'opencode-usage', usagePath: '/usage' },
      pricing: { type: 'models-dev', provider: 'opencode-go' },
    },
    pricing: {},
    note: '$10/月 Go 套餐；$12/5小时、$30/周、$60/月，超出回落余额',
  },
  {
    // OpenCode 官方 AI 网关（按量付费 / 余额充值），OpenAI 兼容端点。
    // adapter=null：不做窗口额度探测；余额不足由上游 402/429/403 经转发层冻结账号。
    id: 'opencode-zen-credit',
    name: 'Open Code ZEN',
    baseUrl: 'https://opencode.ai/zen/v1',
    plan: null,
    adapter: null,
    pricing: { type: 'models-dev', provider: 'opencode-zen' },
    note: 'OpenCode 官方 AI 网关：按量付费（余额充值），OpenAI 兼容 /zen/v1；无固定窗口套餐',
  },
];

/** provider 整体序列化（供 RouterStore 落盘）：先跑一致性守卫 + 锁收敛再取形状；
 *  provider 经显式入参调用其方法，保留子类覆写语义。 */
function serializeProvider(p) {
  try { for (const a of (p.accounts || [])) p._normalizeConsistency(a); } catch {}
  p._reconcileLock();
  return {
    id: p.id,
    name: p.name,
    kind: p.kind,
    baseUrl: p.baseUrl || null,
    apiPort: p.apiPort || null,
    activated: p.activated === true,
    plan: p.plan || null,
    pricing: p.pricing || {},
    presetId: p.presetId || null,
    adapter: p.adapter || null,
    proxyAppId: p.proxyAppId || null,
    proxyRunning: p.proxyRunning || false,
    selectedAccountKeyId: p.selectedAccountKeyId || null,
    activeAccountKeyId: (p.activeAccount && p.activeAccount.keyId) || null,
    accounts: (p.accounts || []).map((a) => {
      p._normalizeConsistency(a);
      return serializeAccount(a);
    }),
    instances: (p.instances || []).map((i) => (i.toJSON ? i.toJSON() : null)).filter(Boolean),
  };
}

module.exports = { keyFingerprint, maskKey, accountModel, serializeAccount, serializeProvider, PROVIDER_PRESETS };
