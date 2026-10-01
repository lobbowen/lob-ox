'use strict';

const guardian = require('../../shared/guardian');

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
      mCrashWindowStart() { return host._mCrashWindowStart(); },
      mCrashWindowRestarts() { return host._mCrashWindowRestarts(); },
      mBackoffLevel() { return host._mBackoffLevel(); },
      mSetCrashWindowStart(v) { return host._mSetCrashWindowStart(v); },
      mSetCrashWindowRestarts(v) { return host._mSetCrashWindowRestarts(v); },
      mSetBackoffLevel(v) { return host._mSetBackoffLevel(v); },
      mSetBackoffUntil(v) { return host._mSetBackoffUntil(v); },
      mSetFailStreak(v) { return host._mSetFailStreak(v); },
      mFailStreak() { return host._mFailStreak(); },
    };
    DEPS.set(host, d);
  }
  return d;
}

module.exports = {
  methods: {
  _bumpCrashWindow() {
    const d = depsOf(this);
    const now = Date.now();
    const dec = guardian.bumpCrashWindow(
      { start: d.mCrashWindowStart(), restarts: d.mCrashWindowRestarts() },
      now,
      { crashWindowMs: d.config().crashWindowMs, crashBurst: d.config().crashBurst, backoff: d.config().backoff, backoffLevel: d.mBackoffLevel() }
    );
    d.mSetCrashWindowStart(dec.start);
    d.mSetCrashWindowRestarts(dec.restarts);
    d.mSetBackoffLevel(dec.backoffLevel);
    if (dec.backoffEntered) {
      d.mSetBackoffUntil(dec.backoffUntil);
      d.state().setPhase('BACKOFF');
      d.events().append('crash_loop_entered', {
        level: dec.backoffLevel,
        waitMs: d.config().backoff[dec.backoffLevel],
      });
      d.logger().error('crash loop entered: level=' + dec.backoffLevel + ' waitMs=' + d.config().backoff[dec.backoffLevel]);
      d.ui().notify('DSH 反复崩溃', '已进入第 ' + dec.backoffLevel + ' 级退避（' + Math.round(d.config().backoff[dec.backoffLevel] / 1000) + 's），请查看 dsh-supervisor 面板');
    }
  },

  _applyHealthCheck(healthOk) {
    const d = depsOf(this);
    if (healthOk) {
      d.mSetFailStreak(0);
      return { restart: false };
    }
    d.mSetFailStreak(d.mFailStreak() + 1);
    const threshold = d.config().failThreshold || 2;
    if (d.mFailStreak() >= threshold) {
      d.events().append('unhealthy', { reason: 'http_unhealthy', streak: d.mFailStreak() });
      return { restart: true, reason: 'http_unhealthy', countCrash: true };
    }
    return { restart: false };
  }
  },
};
