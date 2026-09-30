'use strict';

// 显式意图登记簿（IntentLedger）：一次性语义（consume 即清除，同意图重复 register 覆盖），
// 无时间窗、不因拍数流逝失效。词表 INTENTS 新增动作必须显式扩展。
// 定位：瞬态加速器，非恢复依据。「是否应运行」的持久权威是 desired（managed-objects.json），
// 守卫重启后由 desired 无条件拉起；本登记簿内存态重启即空，禁止靠它解锁首次拉起。

const INTENTS = ['start', 'restart', 'upgrade-resume'];

class IntentLedger {
  constructor() {
    this._pending = new Map(); // intent -> payload（最新意图权威）
  }

  /** intent 必须在词表内（否则抛错）；payload 可选，消费时取回。 */
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

  /** 仅测试/守卫 shutdown 用。 */
  clear() {
    this._pending.clear();
  }
}

module.exports = { IntentLedger, INTENTS };
