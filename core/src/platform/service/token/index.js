'use strict';

const { TokenPool } = require('./pool');
const { parseDshTokenLine } = require('./capture');

class DshTokenService {
  constructor(opts) {
    const o = opts || {};
    this.logger = o.logger || console;
    this.events = o.events || null;
    this.pool = new TokenPool({ logger: this.logger, events: this.events, poolFile: o.poolFile || null });
  }

  attach(id, src) { return this.pool.attach(id, src); }
  detach(id) { return this.pool.detach(id); }

  capture(id) { return this.pool.capture(id); }
  feedLine(id, line) { return this.pool.feedLine(id, line); }
  scheduleCapture(id) { return this.pool.scheduleCapture(id); }
  ensureCaptured(id) { return this.pool.ensureCaptured(id); }

  clear(id) { return this.pool.clear(id); }
  onChange(fn) { return this.pool.onChange(fn); }

  get(id) { return this.pool.get(id); }
  getRecord(id) { return this.pool.getRecord(id); }
  list() { return this.pool.list(); }
}

module.exports = {
  DshTokenService,
  parseDshTokenLine,
};
