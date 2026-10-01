'use strict';

class Lifecycle {
  constructor() {
    this.startedAt = null;
    this.ready = false;
    this.draining = false;
    this.stopping = false;
  }

  markStarted() {
    this.startedAt = new Date().toISOString();
    this.ready = true;
    this.draining = false;
    this.stopping = false;
    return this;
  }

  beginShutdown() {
    this.stopping = true;
    this.draining = true;
    this.ready = false;
    return this;
  }

  isReady() {
    return this.ready === true && this.stopping === false;
  }

  summary() {
    return {
      startedAt: this.startedAt,
      ready: this.isReady(),
      draining: this.draining,
      stopping: this.stopping,
    };
  }
}

module.exports = { Lifecycle };
