'use strict';

// app/main/shadow.js —— 影子记账（_actNote/_mainActualAction/_shadowExcluded/_shadowTickNote/_shadowHeartbeatBeat）。
// 影子对照真实收敛动作，连续零 diff 是收敛切换门槛的观测依据。
// 导出 { methods }，由 app/assembly/facets.js 装到 host；方法名与 { methods } 形态不可改（读源码形态门禁按符号名匹配）。
// 事实经 depsOf(host) 惰性缓存取得。
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
      // 兄弟方法/字段 helper 经 host 既有安装转发。
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
  /** 实际执行动作记账（拍窗口内）。仅在 tick 收敛窗口内生效（_actWindow）；
   *  窗口外的外部动作（child exit / 升级钩子）不记账——其迁移由后续拍相位对分类覆盖。 */
  _actNote(action, reason) {
    const d = depsOf(this);
    if (!d.readActWindow()) return;
    if (!d.readMainTickActs()) d.writeMainTickActs([]);
    d.readMainTickActs().push({ action, reason });
  },

  /** 本拍实际执行的迁移动作：优先拍内执行器记录（最精确且含 reason），否则按相位对分类。 */
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
    // desired=stopped / 升级 hold 的收敛停止迁移
    if (d.state().desired() === 'stopped' || d.upgradeHold()) {
      return { action: 'stop', reason: d.upgradeHold() ? 'upgrade_hold' : 'desired_stopped' };
    }
    return { action: 'none', reason: 'unclassified:' + p };
  },

  /** 影子 diff 排除集：异步事件/守卫业务钩子触发（非主循环收敛决策可比范畴），
   *  不计入 diff 与零 diff 门槛。升级钩子 / child exit / spawn error / 假死。
   *  排除项的意义是豁免异步事件触发的迁移，而不是给凭据驱动的重启开后门。 */
  _shadowExcluded(reason) {
    if (!reason) return false;
    const r = String(reason);
    return /^(exit:|spawn_error|http_unhealthy|upgrade|upgrade_hold|port_occupied)/.test(r);
  },

  /** 拍末影子记账（tick finally 调用：本拍实际迁移已收敛完成）。 */
  _shadowTickNote(t0) {
    const d = depsOf(this);
    try {
      if (d.stopping()) return;
      const actual = d.mainActualAction(t0);
      const shadow = d.main().decideAction(t0);
      const exActual = d.shadowExcluded(actual && actual.reason);
      const diff = !!(actual && shadow) && (actual.action !== shadow.action) && !exActual;
      // 序号自增：初值 undefined 时 Number(undefined)+1 === NaN，这是刻意的起点语义（非漏初始化）。
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

  /** 心跳拍聚合（dsh adapter supervise 调用）：有新 tick 记录才记账/发事件；无则不刷。
   *  连续 5 拍零 diff 记 info（收敛切换门槛观测）。 */
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
        d.logger().info('[shadow] dsh 影子与实际迁移连续 ' + d.readConsistentBeats() + ' 拍零 diff——满足 G3 切换门槛');
      }
    } catch (e) {
      d.logger() && d.logger().warn && d.logger().warn('[shadow] 心跳记账异常: ' + ((e && e.message) || e));
    }
  }
  },
};
