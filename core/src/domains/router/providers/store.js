'use strict';

class AccountStore {
  constructor(opts) {
    const o = opts || {};
    this._persistFn = typeof o.persist === 'function' ? o.persist : null;
    this._canPersist = typeof o.canPersist === 'function' ? o.canPersist : null;
    this.logger = o.logger || null;
  }

  canPersist() {
    return this._canPersist ? this._canPersist() !== false : true;
  }

  persist() {
    if (!this._persistFn) return;
    if (!this.canPersist()) return;
    return this._persistFn();
  }
}

module.exports = { AccountStore };
