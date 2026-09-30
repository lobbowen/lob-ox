'use strict';

// 健康地基：/healthz /readyz。
// healthz=进程活着；readyz=守卫已完成初始化且未在停机。

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
