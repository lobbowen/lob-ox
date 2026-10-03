'use strict';

require('../port-segments');
const { keyFingerprint, maskKey, accountModel, serializeProvider, PROVIDER_PRESETS } = require('./model');
const { AccountStore } = require('./store');
const quota = require('./policies/quota');
const freeze = require('./policies/freeze');

class ProviderBase {
  constructor(opts) {
    const o = opts || {};
    this.id = o.id;
    this.name = o.name;
    this.kind = o.kind;
    this.logger = o.logger || console;
    this.events = o.events || null;
    this.onPersist = o.onPersist || null;
    this.dist = o.dist || null;
    this.config = o.config || null;
    this.store = o.store || new AccountStore({ persist: o.onPersist, canPersist: o.canPersist, logger: this.logger });
    this._hooks = o.hooks || {};
    this.accounts = [];
    this.activeAccount = null;
    this.selectedAccountKeyId = null;
    this.cursor = 0;
    this.apiPort = o.apiPort || null;
    this.activated = o.activated === true;
  }

  selectedKeyId() {
    const locked = this.selectedAccountKeyId
      ? (this.accounts || []).find((a) => a.keyId === this.selectedAccountKeyId)
      : null;
    if (locked && (locked.status === 'ready' || (this.activeAccount && this.activeAccount.keyId === locked.keyId))) {
      return locked.keyId;
    }
    if (this.activeAccount) return this.activeAccount.keyId;
    return (locked && locked.keyId) || null;
  }

  async detectAccount(acc) {
    throw new Error('detectAccount must be implemented by subclass');
  }
  supports(_cap) { return false; }

  accountQuotaSummary(acc) { return quota.accountQuotaSummary(acc); }

  pricingOf(fallback) { return typeof fallback === 'function' ? fallback() : null; }

  async addAccount(key, extra) {
    const existing = this.accounts.find((a) => a.key === key);
    if (existing) return { ok: true, account: existing, already: true };
    const acc = accountModel(key, extra);
    this.accounts.push(acc);
    this._persist();
    const det = await this.detectAccount(acc).catch((e) => ({ ok: false, error: e.message }));
    if (!det.ok) {
      acc.status = 'discarded';
      acc.detectError = det.error;
      this._persist();
      return { ok: false, error: det.error, account: acc };
    }
    acc.quota = det.quota || null;
    const summary = this.accountQuotaSummary(acc);
    this.applyDetection(acc, { ok: true, quota: det.quota || null });
    if (acc.status === 'ready' && this.events) this.events.append('account_ready', { provider: this.name, key: acc.maskedKey });
    const limited = (acc.limit && acc.limit.kind) || null;
    return { ok: true, account: acc, review: false, ...(limited ? { limited } : {}), quota: summary };
  }

  discardAccount(keyId) {
    const idx = this.accounts.findIndex((a) => a.keyId === keyId);
    if (idx < 0) return { ok: false, error: '账号不存在' };
    const acc = this.accounts[idx];
    if (this._hooks && typeof this._hooks.onDiscardAccount === 'function') {
      try { this._hooks.onDiscardAccount(acc); } catch {}
    }
    this.accounts.splice(idx, 1);
    this._persist();
    if (this.events) this.events.append('account_discarded', { provider: this.name, key: acc.maskedKey });
    return { ok: true };
  }

  _isCreditsLow(acc) { return quota.isQuotaCreditsLow(acc && acc.quota); }

  classifyResponse(status, headers, bodyText) {
    return quota.classifyUpstreamLimited(status, bodyText);
  }

  effect(signal, acc, ctx) {
    const c = ctx || {};
    if (signal === 'credits') { if (this.markCreditsExhausted) this.markCreditsExhausted(acc); return true; }
    if (signal === 'window') { if (this.markQuotaExhausted) this.markQuotaExhausted(acc, c.retryMs); return true; }
    if (signal === 'banned') { if (this.markBanned) this.markBanned(acc, c.error || (c.status === 401 ? '401 认证失败' : '账号被封禁')); return true; }
    return false;
  }

  _windowExhausted(acc) { return quota.windowExhausted(acc); }

  _creditsResetDue(acc) { return quota.creditsResetDue(acc); }
  _creditsRefilled(acc) { return quota.creditsRefilled(acc); }

  isAccountUsable(acc, opts) {
    if (!acc || acc.status !== 'ready') return false;
    if (this._isCreditsLow(acc)) return false;
    if (opts && opts.checkWindows === false) return true;
    return !this._windowExhausted(acc);
  }

  _setStatus(acc, status, nextResetAt, error, autoRecover) { return freeze.setStatus(acc, status, nextResetAt, error, autoRecover, this); }
  _ensureLimit(acc) { return freeze.ensureLimit(acc); }
  _previewLimit(acc) { return freeze.previewLimit(acc); }
  _setLimit(acc, kind, reason, recovery) { return freeze.setLimit(acc, kind, reason, recovery, this); }
  _freezeLimited(acc, cause, reason, recovery) { return freeze.freezeLimited(acc, cause, reason, recovery, this); }
  markCreditsExhausted(acc) { return freeze.markCreditsExhausted(acc, this); }
  markQuotaExhausted(acc, cooldownMs) { return freeze.markQuotaExhausted(acc, cooldownMs, this); }
  markBanned(acc, error) { return freeze.markBanned(acc, error, this); }
  applyDetection(acc, det) { const r = freeze.applyDetection(acc, det, this); freeze.ensureLimit(acc); return r; }
  _normalizeConsistency(acc) { return freeze.normalizeConsistency(acc, this); }
  _reconcileLock() { return freeze.reconcileLock(this); }
  _nextResetAt(q) { return quota.nextResetAt(q); }

  markInUse(keyId) {
    const acc = (this.accounts || []).find((a) => a.keyId === keyId);
    if (!acc) return;
    if (!this.activeAccount || this.activeAccount.keyId !== keyId) {
      this.activeAccount = acc;
      this._persist();
    }
  }

  markNotInUse(keyId) {
    if (this.activeAccount && this.activeAccount.keyId === keyId) {
      this.activeAccount = null;
      this._persist();
    }
  }

  usageOf(acc) {
    if (!acc) return 'idle';
    if (this.activeAccount && this.activeAccount.keyId === acc.keyId) return 'in-use';
    return 'idle';
  }

  _persist() {
    if (this.store) return this.store.persist();
    if (this.onPersist) this.onPersist();
  }

  serialize() { return serializeProvider(this); }
}

module.exports = {
  ProviderBase,
  keyFingerprint,
  maskKey,
  normalizeResetTs: quota.normalizeResetTs,
  isQuotaCreditsLow: quota.isQuotaCreditsLow,
  quotaOverallStatus: quota.quotaOverallStatus,
  classifyUpstreamLimited: quota.classifyUpstreamLimited,
  headerRetryMs: quota.headerRetryMs,
  bodyResetMs: quota.bodyResetMs,
  PROVIDER_PRESETS,
};
