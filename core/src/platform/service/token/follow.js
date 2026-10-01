'use strict';

class FollowBus {
  constructor(opts) {
    const o = opts || {};
    this.logger = o.logger || console;
    this._listeners = new Set();
  }

  on(fn) {
    if (typeof fn === 'function') this._listeners.add(fn);
    return () => { try { this._listeners.delete(fn); } catch {  } };
  }

  emit(id, value, record) {
    for (const fn of Array.from(this._listeners)) {
      try { fn(id, value === undefined ? null : value, record || null); }
      catch (e) {
        this.logger.warn && this.logger.warn('[token] onChange(' + id + ') listener error: ' + ((e && e.message) || e));
      }
    }
  }
}

module.exports = { FollowBus };
