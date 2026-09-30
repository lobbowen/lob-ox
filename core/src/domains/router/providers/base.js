'use strict';

// 供应商基座：抽象契约 + 账号池 + 检测应用。
// 状态前置原则：添加账号必须启动检测（拿配额），检测结果与运行中共用同一状态机：
//   受限则 frozen + limit + recovery，正常则 ready；一账号一实例（按 key 去重）。
// 纯策略在 model.js / policies/*，落盘经 store.js；本文件只做契约与账号池编排。

require('../port-segments'); // 本域端口段/独立池申报（require 即注入）
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
    this.selectedAccountKeyId = null; // 统一锁定（直连/反代共用）：持久化，用户显式锁定/切换时写
    this.cursor = 0;
    // apiPort=持久化端口绑定（激活时分配、停用保留，防漂移）；activated=是否激活
    this.apiPort = o.apiPort || null;
    this.activated = o.activated === true;
  }

  /** 当前「实际在用/应高亮」账号 keyId：优先持久化锁定（若可用/在用），否则自动在用 activeAccount。 */
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
  // 能力契约声明（PG-1）：process-pool 能力面由 providers/process-pool.js 的 mixin 实现并
  // 并入 supports 词表——契约在能力方声明，基座不携带实现不了的抛错占位；
  // 调用方一律以 supports(cap) 守卫。
  /** 本 provider 是否具备某项能力；缺省为无 process 能力（最保守）。 */
  supports(_cap) { return false; }

  accountQuotaSummary(acc) { return quota.accountQuotaSummary(acc); }

  /** 结算单价来源（转发收口按此多态分派，取代 kind 字面量分支）：
   *  缺省=调用方注入的全局单价 fallback；直连覆写为官方单价。 */
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
    // 入库即如实、且与运行中同一状态机：受限则 frozen + limit + recovery，正常则 ready。
    this.applyDetection(acc, { ok: true, quota: det.quota || null });
    if (acc.status === 'ready' && this.events) this.events.append('account_ready', { provider: this.name, key: acc.maskedKey });
    const limited = (acc.limit && acc.limit.kind) || null;
    return { ok: true, account: acc, review: false, ...(limited ? { limited } : {}), quota: summary };
  }

  discardAccount(keyId) {
    const idx = this.accounts.findIndex((a) => a.keyId === keyId);
    if (idx < 0) return { ok: false, error: '账号不存在' };
    const acc = this.accounts[idx];
    // 实例/端口清理属 process-pool 能力方（钩子由 process-pool.js 的 mixin ctor 装配）：
    // 经钩子执行以打破 base 到池的 this 反向边（DG-4）。
    if (this._hooks && typeof this._hooks.onDiscardAccount === 'function') {
      try { this._hooks.onDiscardAccount(acc); } catch {}
    }
    this.accounts.splice(idx, 1);
    this._persist();
    if (this.events) this.events.append('account_discarded', { provider: this.name, key: acc.maskedKey });
    return { ok: true };
  }

  /** credits 受限判定（单源纯函数；可被覆写）。 */
  _isCreditsLow(acc) { return quota.isQuotaCreditsLow(acc && acc.quota); }

  /** 上游响应转为 signal（供应商可覆写识别专属错误码；router 不内置词表）。 */
  classifyResponse(status, headers, bodyText) {
    return quota.classifyUpstreamLimited(status, bodyText);
  }

  /** 账号处置副作用契约：router 只发 signal，具体冻结/停实例/封号由 provider 执行。 */
  effect(signal, acc, ctx) {
    const c = ctx || {};
    if (signal === 'credits') { if (this.markCreditsExhausted) this.markCreditsExhausted(acc); return true; }
    if (signal === 'window') { if (this.markQuotaExhausted) this.markQuotaExhausted(acc, c.retryMs); return true; }
    if (signal === 'banned') { if (this.markBanned) this.markBanned(acc, c.error || (c.status === 401 ? '401 认证失败' : '账号被封禁')); return true; }
    return false;
  }

  /** 唯一「时间窗额度用尽」判定。 */
  _windowExhausted(acc) { return quota.windowExhausted(acc); }

  _creditsResetDue(acc) { return quota.creditsResetDue(acc); }
  _creditsRefilled(acc) { return quota.creditsRefilled(acc); }

  /** 账号可用性判定（唯一事实）：ready 且未「预付余额不足」且窗口未满。 */
  isAccountUsable(acc, opts) {
    if (!acc || acc.status !== 'ready') return false;
    if (this._isCreditsLow(acc)) return false;
    if (opts && opts.checkWindows === false) return true;
    return !this._windowExhausted(acc);
  }

  // 冻结/恢复策略（policies/freeze.js）
  _setStatus(acc, status, nextResetAt, error, autoRecover) { return freeze.setStatus(acc, status, nextResetAt, error, autoRecover, this); }
  _ensureLimit(acc) { return freeze.ensureLimit(acc); }
  /** limit 纯只读预览（不赋值、不写盘）：只读视图唯一入口。写版 _ensureLimit 保留（门禁/测试消费）。 */
  _previewLimit(acc) { return freeze.previewLimit(acc); }
  _setLimit(acc, kind, reason, recovery) { return freeze.setLimit(acc, kind, reason, recovery, this); }
  _freezeLimited(acc, cause, reason, recovery) { return freeze.freezeLimited(acc, cause, reason, recovery, this); }
  markCreditsExhausted(acc) { return freeze.markCreditsExhausted(acc, this); }
  markQuotaExhausted(acc, cooldownMs) { return freeze.markQuotaExhausted(acc, cooldownMs, this); }
  markBanned(acc, error) { return freeze.markBanned(acc, error, this); }
  // applyDetection 是唯一状态投影入口（覆盖全部调用方）：投影完成后补齐 limit（写版 ensureLimit）。
  applyDetection(acc, det) { const r = freeze.applyDetection(acc, det, this); freeze.ensureLimit(acc); return r; }
  _normalizeConsistency(acc) { return freeze.normalizeConsistency(acc, this); }
  _reconcileLock() { return freeze.reconcileLock(this); }
  _nextResetAt(q) { return quota.nextResetAt(q); }

  // 账号使用状态（纯派生，不持久化）
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

  /** 使用状态纯派生：in-use=activeAccount 指向；idle=其余。warming 由 process-pool mixin 覆写派生。 */
  usageOf(acc) {
    if (!acc) return 'idle';
    if (this.activeAccount && this.activeAccount.keyId === acc.keyId) return 'in-use';
    // warming（实例已热但未在用）由 process-pool mixin 覆写派生；基座只认在用一个事实。
    return 'idle';
  }

  /** 落盘（经 store 单闸）。 */
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
  fmtClock: quota.fmtClock,
  monthlyResetAtOf: quota.monthlyResetAtOf,
  isQuotaCreditsLow: quota.isQuotaCreditsLow,
  quotaOverallStatus: quota.quotaOverallStatus,
  classifyUpstreamLimited: quota.classifyUpstreamLimited,
  headerRetryMs: quota.headerRetryMs,
  bodyResetMs: quota.bodyResetMs,
  PROVIDER_PRESETS,
};
