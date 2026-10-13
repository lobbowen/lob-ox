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

  // isAccountUsable 的唯一实现在 instance-lifecycle.js（proxy.js:80 委托过去，
  // 首参从 this 换成 provider，逻辑逐字等价）。此处曾有一份副本，对 ProxyProvider
  // 是死代码——两份各自演化必然分叉，故只留一份。
  isAccountUsable(acc, opts) {
    return require('./instance-lifecycle').isAccountUsable(this, acc, opts);
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

  // R7/D.7-P0-7：markInUse 原先在每次切号时 this._persist()，而 _persist 走
  // RouterStore.save 的 writeDurable（同步 fsync + rename），serializeAccount 又原样
  // 输出所有账号的明文 key。于是多账号轮询时**每个请求一次同步全量落盘，含全部
  // 凭据明文重写**——既阻塞事件循环，又放大凭据暴露面。
  // activeAccount 是易变派生状态（下一秒可能就切走），不属于需要立即持久化的配置。
  // 改为只改内存加置 dirty，由节流定时器合流落盘（参照 store/usage.js 的
  // _scheduleWrite 范式，那是项目里已有的正确做法）。
  markInUse(keyId) {
    const acc = (this.accounts || []).find((a) => a.keyId === keyId);
    if (!acc) return;
    if (!this.activeAccount || this.activeAccount.keyId !== keyId) {
      this.activeAccount = acc;
      this._schedulePersist();
    }
  }

  markNotInUse(keyId) {
    if (this.activeAccount && this.activeAccount.keyId === keyId) {
      this.activeAccount = null;
      this._schedulePersist();
    }
  }

  // 节流持久化：1 秒合流。进程退出前由 shutdown 路径调 flushPersist 兜底。
  _schedulePersist() {
    if (this._persistTimer) return;
    this._persistTimer = setTimeout(() => {
      this._persistTimer = null;
      this._persist();
    }, 1000);
    if (this._persistTimer && typeof this._persistTimer.unref === 'function') this._persistTimer.unref();
  }

  flushPersist() {
    if (this._persistTimer) { clearTimeout(this._persistTimer); this._persistTimer = null; }
    this._persist();
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
