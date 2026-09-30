'use strict';

// 切换控制器：S1 选号（policies/switch.pickAccount）与 S2 失败反应（policies/failure.decideFailure）
// 两个纯策略的编排层——只施加副作用（markInUse/cursor/事件/持久化/provider.effect），决定「重试/透传」。
// 信号语义（credits/window/banned/transient/none）判定归 provider.classifyResponse。
// 硬契约：绝不跨供应商 failover——每个供应商只在自己的账号池内选号。

const { pickAccount } = require('./policies/switch');
const { decideFailure } = require('./policies/failure');

class SwitchEngine {
  constructor(opts) {
    this.logger = opts.logger || console;
    this.events = opts.events || null;
    this.onPersist = opts.onPersist || null; // selected 失效自动清理时持久化
  }

  /** 在指定供应商池内选号（不跨池，见文件头）。opts.excludeKeys=Set 时排除本请求内瞬时故障账号，强制轮换不粘滞。 */
  pickFor(provider, opts) {
    if (!provider) return null;
    return this._pickIn(provider, opts);
  }

  /** 选号编排：预算 usable/running，调 S1 纯策略，再应用决策（清锁/写 cursor/标记在用/事件）。 */
  _pickIn(p, opts) {
    const instancePool = p.supports('instanceLifecycle');
    const accounts = p.accounts || [];
    const state = {
      accounts: accounts.map((a) => ({
        key: a.key, keyId: a.keyId, maskedKey: a.maskedKey, status: a.status,
        usable: !!p.isAccountUsable(a),
        running: !instancePool || !!(a.instance && a.instance.pid),
      })),
      selectedAccountKeyId: p.selectedAccountKeyId || null,
      activeAccountKeyId: p.activeAccount ? p.activeAccount.keyId : null,
      cursor: p.cursor || 0,
      instancePool,
    };
    const d = pickAccount(state, opts);
    if (d.clearSelected) {
      p.selectedAccountKeyId = null;
      if (this.onPersist) this.onPersist();
    }
    if (!d.keyId) return null;
    const picked = accounts.find((a) => a.keyId === d.keyId) || null;
    if (!picked) return null;
    if (d.reason === 'rotate') p.cursor = d.nextCursor;
    if (typeof p.markInUse === 'function') p.markInUse(picked.keyId); else p.activeAccount = picked;
    if (this.events) this.events.append('router_pick', { provider: p.name, key: picked.maskedKey });
    return picked;
  }

  /** 上游失败反应（唯一编排点）。ctx = { status, headers, body, attempt, attempts, error? }；
   *  action/retry 语义见 policies/failure.js decideFailure 契约。 */
  reactToFailure(provider, acc, ctx) {
    const c = ctx || {};
    const status = c.status;
    const text = String(c.body || '');
    const sig = (provider && typeof provider.classifyResponse === 'function')
      ? provider.classifyResponse(status, c.headers, text)
      : 'none';
    const key = (acc && acc.maskedKey) || '?';
    const d = decideFailure(sig, { status, headers: c.headers, body: text, key });
    // 行为不变量：window 信号必须在 provider.effect 之前把 retryMs 写入 ctx，
    // 否则 markQuotaExhausted(acc, cooldownMs) 拿到 undefined。
    if (sig === 'window') c.retryMs = d.retryMs;
    if (d.needEffect && provider && provider.effect) provider.effect(sig, acc, c);
    if (d.info && this.logger && this.logger.info) this.logger.info(d.info);
    if (d.action === 'retry') {
      const res = { action: 'retry', signal: sig };
      if (d.transient) res.transient = true;
      if (d.log) res.log = d.log;
      return res;
    }
    const res = { action: 'passthrough', signal: sig, status, headers: c.headers, body: text };
    if (d.log) res.log = d.log;
    return res;
  }
}

module.exports = { SwitchEngine };
