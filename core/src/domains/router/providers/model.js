'use strict';

const crypto = require('node:crypto');

function keyFingerprint(k) {
  if (!k) return 'unknown';
  const hash = crypto.createHash('sha256').update(String(k)).digest('hex').slice(0, 10);
  return hash + '…' + String(k).slice(-4);
}

function maskKey(k) {
  if (!k || String(k).length <= 8) return '***';
  return '...' + String(k).slice(-6);
}

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
    id: 'opencode-zen-credit',
    name: 'Open Code ZEN',
    baseUrl: 'https://opencode.ai/zen/v1',
    plan: null,
    adapter: null,
    pricing: { type: 'models-dev', provider: 'opencode-zen' },
    note: 'OpenCode 官方 AI 网关：按量付费（余额充值），OpenAI 兼容 /zen/v1；无固定窗口套餐',
  },
];

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
