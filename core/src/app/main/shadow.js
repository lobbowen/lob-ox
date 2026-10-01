'use strict';

const DEPS = new WeakMap();
function depsOf(host) {
  let d = DEPS.get(host);
  if (!d) {
    d = {
      state() { return host.state; },
      main() { return host.main; },
      logger() { return host.logger; },
      events() { return host.events; },
      upgradeHold() { return host._upgradeHold; },
      stopping() { return host._stopping; },
      mAdopted() { return host._mAdopted(); },
      mainActualAction(t0) { return host._mainActualAction(t0); },
      shadowExcluded(r) { return host._shadowExcluded(r); },
      readActWindow() { return host._actWindow; },
      readMainTickActs() { return host._mainTickActs; },
      writeMainTickActs(v) { host._mainTickActs = v; },
      readShadowSeq() { return host._shadowSeq; },
      writeShadowSeq(v) { host._shadowSeq = v; },
      readShadowLast() { return host._shadowLast; },
      writeShadowLast(v) { host._shadowLast = v; },
      readShadowLoggedSeq() { return host._shadowLoggedSeq; },
      writeShadowLoggedSeq(v) { host._shadowLoggedSeq = v; },
      readConsistentBeats() { return host._shadowConsistentBeats; },
      writeConsistentBeats(v) { host._shadowConsistentBeats = v; },
      readDiffBeats() { return host._shadowDiffBeats; },
      writeDiffBeats(v) { host._shadowDiffBeats = v; },
    };
    DEPS.set(host, d);
  }
  return d;
}

module.exports = {
  methods: {
  _actNote(action, reason) {
    const d = depsOf(this);
    if (!d.readActWindow()) return;
    if (!d.readMainTickActs()) d.writeMainTickActs([]);
    d.readMainTickActs().push({ action, reason });
  },

  _mainActualAction(t0) {
    const d = depsOf(this);
    const acts = d.readMainTickActs() || [];
    if (acts.length > 0) return acts[acts.length - 1];
    const from = t0.phase;
    const to = d.state().phase();
    if (from === to) return { action: 'none', reason: 'steady' };
    const p = from + '>' + to;
    if (p === 'STOPPED>STARTING') return { action: 'start', reason: 'spawn' };
    if (p === 'STOPPED>RUNNING') return d.mAdopted() === true ? { action: 'adopt', reason: 'adopt' } : { action: 'start', reason: 'spawn+enterRunning' };
    if (p === 'STOPPED>OBSERVED') return { action: 'adoptObserved', reason: 'observe' };
    if (p === 'STARTING>RUNNING') return { action: 'enterRunning', reason: 'healthy' };
    if (p === 'STARTING>RESTARTING') return { action: 'restart', reason: 'start_timeout' };
    if (p === 'STARTING>BACKOFF') return { action: 'restart', reason: 'start_crash' };
    if (p === 'RUNNING>RESTARTING') return { action: 'restart', reason: 'in_tick_restart' };
    if (p === 'RUNNING>BACKOFF') return { action: 'restart', reason: 'crash_loop' };
    if (p === 'RESTARTING>STARTING') return { action: 'start', reason: 'restart_spawn' };
    if (p === 'RESTARTING>RUNNING') return d.mAdopted() === true ? { action: 'adopt', reason: 'restart_adopt' } : { action: 'enterRunning', reason: 'restart_enter' };
    if (p === 'RESTARTING>BACKOFF') return { action: 'restart', reason: 'crash_loop' };
    if (p === 'BACKOFF>STARTING') return { action: 'start', reason: 'backoff_spawn' };
    if (p === 'BACKOFF>RUNNING') return d.mAdopted() === true ? { action: 'adopt', reason: 'backoff_adopt' } : { action: 'enterRunning', reason: 'backoff_enter' };
    if (p === 'OBSERVED>RUNNING') return { action: 'adopt', reason: 'observed_promote' };
    if (d.state().desired() === 'stopped' || d.upgradeHold()) {
      return { action: 'stop', reason: d.upgradeHold() ? 'upgrade_hold' : 'desired_stopped' };
    }
    return { action: 'none', reason: 'unclassified:' + p };
  },

  _shadowExcluded(reason) {
    if (!reason) return false;
    const r = String(reason);
    return /^(exit:|spawn_error|http_unhealthy|upgrade|upgrade_hold|port_occupied)/.test(r);
  },

  _shadowTickNote(t0) {
    const d = depsOf(this);
    try {
      if (d.stopping()) return;
      const actual = d.mainActualAction(t0);
      const shadow = d.main().decideAction(t0);
      const exActual = d.shadowExcluded(actual && actual.reason);
      const diff = !!(actual && shadow) && (actual.action !== shadow.action) && !exActual;
      const seq = Number(d.readShadowSeq()) + 1;
      d.writeShadowSeq(seq);
      const rec = {
        seq: seq,
        t0phase: t0.phase,
        phase: d.state().phase(),
        shadow: shadow.action + (shadow.reason ? ':' + shadow.reason : ''),
        actual: actual.action + (actual.reason ? ':' + actual.reason : ''),
        diff: !!diff,
        excluded: !!exActual,
      };
      d.writeShadowLast(rec);
      if (diff && d.logger() && d.logger().warn) {
        d.logger().warn('[shadow] dsh 影子 vs 实际不一致: shadow=' + rec.shadow + ' actual=' + rec.actual + '（phase ' + rec.t0phase + '→' + rec.phase + '）');
      }
    } catch (e) {
      d.logger() && d.logger().warn && d.logger().warn('[shadow] 拍末记账异常: ' + ((e && e.message) || e));
    }
  },

  _shadowHeartbeatBeat() {
    const d = depsOf(this);
    try {
      const rec = d.readShadowLast();
      if (!rec) return;
      if (d.readShadowLoggedSeq() === rec.seq) return;
      d.writeShadowLoggedSeq(rec.seq);
      if (rec.excluded) {
        if (d.logger() && d.logger().debug) d.logger().debug('[shadow] 拍#' + rec.seq + ' 业务钩子迁移(不计 diff): ' + rec.actual);
        return;
      }
      if (rec.diff) {
        d.writeConsistentBeats(0);
        d.writeDiffBeats(d.readDiffBeats() + 1);
      } else {
        d.writeConsistentBeats(d.readConsistentBeats() + 1);
      }
      const ev = {
        seq: rec.seq,
        phase: rec.t0phase + '>' + rec.phase,
        shadow: rec.shadow,
        actual: rec.actual,
        diff: rec.diff,
        consistentBeats: d.readConsistentBeats(),
        diffBeats: d.readDiffBeats(),
      };
      if (d.events() && d.events().append) { try { d.events().append('shadow_dsh_action', ev); } catch {} }
      if (!rec.diff && d.readConsistentBeats() > 0 && d.readConsistentBeats() % 5 === 0 && d.logger() && d.logger().info) {
        d.logger().info('[shadow] dsh 影子与实际迁移连续 ' + d.readConsistentBeats() + ' 拍零 diff——满足切换门槛');
      }
    } catch (e) {
      d.logger() && d.logger().warn && d.logger().warn('[shadow] 心跳记账异常: ' + ((e && e.message) || e));
    }
  }
  },
};
