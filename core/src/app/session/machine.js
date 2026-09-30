'use strict';

// 会话状态机（真 ctor 注入工厂）：自己持有会话态，可只 require 本模块 + 假 deps 断言。
// deps 均为惰性取值函数（装配期 host.config/logger 尚未就绪）。

function createSession(deps) {
  const g = deps || {};
  const ev = () => (typeof g.events === 'function' ? g.events() : null);
  let state = 'starting'; // 契约：starting -> running -> stopping -> stopped

  /** 会话态迁移（同值短路；迁移发事件）。 */
  function setState(s) {
    if (state === s) return;
    const prev = state;
    state = s;
    const events = ev();
    if (events) { try { events.append('session_state', { from: prev, to: s }); } catch {} }
  }

  /** 是否处于「退出中/已退出」——此期间一切自动拉起必须抑制（INV-S1）。 */
  function halting() { return state === 'stopping' || state === 'stopped'; }

  /** 契约：是否应运行 = desired==running && 非 halting && 非崩溃停靠。 */
  function shouldRun() {
    if (g.desired() !== 'running') return false;
    if (halting()) return false;
    if (typeof g.crashHalted === 'function' && g.crashHalted()) return false;
    return true;
  }

  return { state: () => state, setState, halting, shouldRun };
}

module.exports = { createSession };
