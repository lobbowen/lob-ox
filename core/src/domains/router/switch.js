'use strict';

const { pickAccount } = require('./policies/switch');
const { decideFailure } = require('./policies/failure');

class SwitchEngine {
  constructor(opts) {
    this.logger = opts.logger || console;
    this.events = opts.events || null;
    this.onPersist = opts.onPersist || null;
  }

  pickFor(provider, opts) {
    if (!provider) return null;
    return this._pickIn(provider, opts);
  }

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

  reactToFailure(provider, acc, ctx) {
    const c = ctx || {};
    const status = c.status;
    const text = String(c.body || '');
    const sig = (provider && typeof provider.classifyResponse === 'function')
      ? provider.classifyResponse(status, c.headers, text)
      : 'none';
    const key = (acc && acc.maskedKey) || '?';
    const d = decideFailure(sig, { status, headers: c.headers, body: text, key });
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
