'use strict';

const INTENTS = ['start', 'restart', 'upgrade-resume'];

class IntentLedger {
  constructor() {
    this._pending = new Map();
  }

  register(intent, payload) {
    if (!INTENTS.includes(intent)) throw new Error('未知意图: ' + intent + '（词表: ' + INTENTS.join(',') + '）');
    this._pending.set(intent, payload === undefined ? null : payload);
    return this;
  }

  consume(intent) {
    const p = this._pending.get(intent);
    if (this._pending.has(intent)) this._pending.delete(intent);
    return p;
  }

  // W5：生产零调用，仅 session-lifecycle-test.js 用于「模拟重启后内存态为空」的夹具。
  // 保留（它是一个合理的测试缝），不视为待删死代码。
  clear() {
    this._pending.clear();
  }
}

module.exports = { IntentLedger, INTENTS };
