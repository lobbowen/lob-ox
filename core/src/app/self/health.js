'use strict';

const { Lifecycle } = require('./lifecycle');

class Health {
  constructor(lifecycle) {
    this.lifecycle = lifecycle || new Lifecycle();
  }

  live() {
    return { ok: true, pid: process.pid, uptimeMs: process.uptime() * 1000 };
  }

  ready() {
    const ok = this.lifecycle.isReady();
    return { ok, ready: ok, lifecycle: this.lifecycle.summary() };
  }
}

module.exports = { Health };
