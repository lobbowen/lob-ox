'use strict';

const INSTANCE_STATES = Object.freeze({
  COLD: 'COLD', WARM: 'WARM', HOT: 'HOT', DEAD: 'DEAD',
});

function isServable(inst) {
  return !!inst && inst.status === INSTANCE_STATES.HOT && !!inst.pid;
}

function occupiesSlot(inst) {
  return !!inst && (inst.status === INSTANCE_STATES.WARM
    || inst.status === INSTANCE_STATES.HOT || inst.status === INSTANCE_STATES.DEAD);
}

function serializeInstance(inst) {
  return {
    key: inst.key,
    keyId: inst.keyId,
    maskedKey: inst.maskedKey,
    status: inst.status,
    healthy: inst.healthy,
    quota: inst.quota,
    registeredAt: inst.registeredAt,
    version: inst.version || null,
    port: inst.port || null,
  };
}

class ProxyInstance {
  constructor(opts) {
    this.key = opts.key || null;
    this.keyId = opts.keyId;
    this.maskedKey = opts.maskedKey;
    this.app = opts.app || null;
    this.logger = opts.logger || console;
    this.events = opts.events || null;
    this.onEvent = opts.onEvent || null;
    this.status = INSTANCE_STATES.COLD;
    this.healthy = false;
    this.quota = null;
    this.registeredAt = Date.now();
    this.pid = null;
    this.port = null;
    this.pidFile = null;
    this.launchAnchors = null;
    this.version = null;
    this.startingPromise = null;
    this._unhealthyCount = 0;
    this._restartAt = 0;
    this._monitorFails = 0;
    this._lastProblem = null;
    this._restartPending = null;
  }

  toJSON() { return serializeInstance(this); }

  isServable() { return isServable(this); }

  occupiesSlot() { return occupiesSlot(this); }

  static fromJSON(o) { return deserializeInstance(o); }
}

function deserializeInstance(o) {
  const i = new ProxyInstance({ key: o.key || null, keyId: o.keyId, maskedKey: o.maskedKey });
  i.status = INSTANCE_STATES.COLD;
  i.healthy = false;
  i.quota = o.quota || null;
  i.registeredAt = o.registeredAt || Date.now();
  i.version = o.version || null;
  i.port = o.port || null;
  return i;
}

module.exports = { ProxyInstance, INSTANCE_STATES, isServable, occupiesSlot, serializeInstance, deserializeInstance };
