'use strict';

const guardian = require('../../shared/guardian');
const pmClient = require('../../platform/contract/pm-client');

const DEPS = new WeakMap();
function depsOf(host) {
  let d = DEPS.get(host);
  if (!d) {
    d = {
      config() { return host.config; },
      state() { return host.state; },
      events() { return host.events; },
      logger() { return host.logger; },
      ui() { return host.ui; },
      mStartupFailWindowStart() { return host._mStartupFailWindowStart(); },
      mStartupFailCount() { return host._mStartupFailCount(); },
      mSetStartupFailWindowStart(v) { return host._mSetStartupFailWindowStart(v); },
      mSetStartupFailCount(v) { return host._mSetStartupFailCount(v); },
    };
    DEPS.set(host, d);
  }
  return d;
}

module.exports = {
  methods: {
  
  
  _noteStartupFailure() {
    const d = depsOf(this);
    const windowMs = d.config().startupFailWindowMs || 60000;
    const dec = guardian.bumpStartupFailure(
      { start: d.mStartupFailWindowStart(), count: d.mStartupFailCount() },
      Date.now(),
      { windowMs, burst: d.config().startupFailBurst }
    );
    d.mSetStartupFailWindowStart(dec.start);
    d.mSetStartupFailCount(dec.count);
    if (!dec.tripped) return { failed: false, count: dec.count };
    d.state().setPhase('FAILED');
    d.events().append('startup_failed', {
      count: dec.count, windowMs, retry: '/lifecycle/dsh/restart',
    });
    d.logger().error('启动失败 ' + dec.count + ' 次（窗口 ' + Math.round(windowMs / 1000)
      + 's）→ FAILED：停止自动重启，等待人工重试（/lifecycle/dsh/restart）');
    d.ui().notify('DSH 启动反复失败',
      dec.count + ' 次启动失败（' + Math.round(windowMs / 1000) + 's 内），已停止自动重启；请在面板点「重启」重试');
    return { failed: true, count: dec.count };
  },

  
  _retryStartupFailure() {
    const d = depsOf(this);
    d.mSetStartupFailWindowStart(null);
    d.mSetStartupFailCount(0);
    pmClient.resetBackoff('main');
    d.events().append('startup_retry', {});
    d.logger().warn('启动失败计数已清零：人工重试，回到 STARTING');
    return { ok: true };
  },
  },
};
