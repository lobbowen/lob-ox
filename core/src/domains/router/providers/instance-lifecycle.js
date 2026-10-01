'use strict';

const { INSTANCE_STATES } = require('../model');
const pidlook = require('../../../platform/os/pidlookup');
const carrier = require('../../../platform/os/carrier');
const ports = require('../../../platform/service/ports').shared;
const { accountModel } = require('./model');

function canStopInstance(provider, acc) {
  if (!acc) return true;
  if ((acc.inflight || 0) > 0) return false;
  if (acc.status === 'ready' && provider.isAccountUsable(acc)) {
    if (provider.selectedAccountKeyId === acc.keyId || (provider.activeAccount && provider.activeAccount.keyId === acc.keyId)) return false;
  }
  return true;
}

const STOP_PENDING_MAX_MS = 5 * 60 * 1000;

function arbitrateStop(provider, inst, force) {
  if (!inst) return;
  const acc = provider.accounts.find((a) => a.keyId === inst.keyId) || null;
  if (acc && !force && !canStopInstance(provider, acc)) {
    const now = Date.now();
    if (!acc._stopPendingSince) acc._stopPendingSince = now;
    if (now - acc._stopPendingSince <= STOP_PENDING_MAX_MS) {
      acc._stopPendingUntilIdle = true;
      return;
    }
  }
  if (acc) { acc._stopPendingUntilIdle = false; acc._stopPendingSince = 0; }
  if (!inst.pid) {
    inst.status = INSTANCE_STATES.COLD;
    inst.healthy = false;
    provider._persist();
    return;
  }
  // pid 必须在置 null 前快照，否则 kill(-null)=kill(-0) 会自杀当前进程组。
  const pid = inst.pid;
  if (provider._terminatingPids && provider._terminatingPids.size) {
    for (const q of [...provider._terminatingPids]) {
      let al = true;
      try { al = pidlook.isAlive ? pidlook.isAlive(q) : true; } catch { al = false; }
      if (!al) provider._terminatingPids.delete(q);
    }
  }
  try { provider._terminatingPids.add(pid); } catch {}
  carrier.signalTermination(pid);
  inst.pid = null;
  inst.status = INSTANCE_STATES.COLD;
  inst.healthy = false;
  provider._persist();
}

function retryPendingStop(provider, acc) {
  if (!acc || !acc._stopPendingUntilIdle) return;
  if ((acc.inflight || 0) > 0) return;
  const inst = provider.instanceOf(acc);
  if (inst && inst.pid) { arbitrateStop(provider, inst); }
  else { acc._stopPendingUntilIdle = false; acc._stopPendingSince = 0; }
}

function reclaimAccount(provider, acc) {
  if (!acc) return;
  const inst = provider.instanceOf(acc);
  if (inst) { try { arbitrateStop(provider, inst, true); } catch {} }
  try { ports.unregister('proxy:' + acc.keyId); } catch {}
  if (inst) inst.port = null;
  provider._persist();
}

async function waitHealthy(provider, inst, tries) {
  const n = tries === undefined ? 6 : tries;
  for (let i = 0; i < n; i++) {
    await provider.healthInstance(inst);
    if (inst.healthy) return true;
    if (inst.status === INSTANCE_STATES.COLD) return false;
    await new Promise((r) => setTimeout(r, 1500));
  }
  return false;
}

function isAccountUsable(provider, acc, opts) {
  if (!acc || acc.status !== 'ready') return false;
  if (provider._isCreditsLow(acc)) return false;
  const inst = acc.instance || (provider.instances || []).find((i) => i.keyId === acc.keyId);
  if (!inst) return false;
  if (opts && opts.checkWindows === false) return true;
  return !provider._windowExhausted(acc);
}

async function addAccount(provider, key, extra) {
  const existing = provider.accounts.find((a) => a.key === key);
  if (existing) return { ok: true, account: existing, already: true };
  const inst = await provider.ensureInstance(key);
  const acc = accountModel(key, { instance: inst, ...(extra || {}) });
  provider.accounts.push(acc);
  provider._persist();
  try { await provider._ensurePkgCached(provider.app); } catch {}
  const r = await provider.startInstance(inst);
  if (!r.ok) {
    acc.status = 'discarded';
    acc.detectError = r.error;
    provider._persist();
    return { ok: false, error: r.error, account: acc };
  }
  const healthy = await waitHealthy(provider, inst);
  if (!healthy) {
    acc.status = 'discarded';
    acc.detectError = '实例启动失败（探活超时）';
    provider._persist();
    return { ok: false, error: acc.detectError, account: acc };
  }
  const det = await provider.detectInstanceQuota(inst);
  if (!det.ok && !det.quota) {
    acc.status = 'discarded';
    acc.detectError = det.error || '无法获取配额';
    provider._persist();
    return { ok: false, error: acc.detectError, account: acc };
  }
  acc.quota = det.quota || null;
  inst.quota = det.quota || null;
  const summary = provider.accountQuotaSummary(acc);
  provider.applyDetection(acc, { ok: true, quota: det.quota || null });
  if (acc.status === 'ready' && provider.events) provider.events.append('account_ready', { provider: provider.name, key: acc.maskedKey });
  const limited = (acc.limit && acc.limit.kind) || null;
  return { ok: true, account: acc, review: false, ...(limited ? { limited } : {}), quota: summary };
}

module.exports = { canStopInstance, arbitrateStop, retryPendingStop, reclaimAccount, waitHealthy, isAccountUsable, addAccount };
