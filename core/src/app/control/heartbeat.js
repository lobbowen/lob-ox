'use strict';

// app/control/heartbeat.js —— 受管目录的心跳与调度（IO/定时/监督）。
// 三层分离：managed-object.js 纯模型；registry.js 目录 CRUD+持久化；本模块心跳驱动。
// 本模块无 this，以 registry 显式入参驱动；依赖单向：registry.js -> heartbeat.js（不回 require）。

/** 单对象监督的超时上限（拍宽倍数，见 withTimeout：超时按失败处理，绝不无限等待）。 */
const ADAPTER_TIMEOUT_TICKS = 6;

function withTimeout(registry, p, ms, id) {
  let t = null;
  const timeout = new Promise((resolve) => {
    t = setTimeout(() => resolve({ __timedOut: true, ok: false, error: '监督超时(' + ms + 'ms)' }), ms);
    // 不拖住进程退出（守卫优雅停机不被计时器拦）
    if (t && typeof t.unref === 'function') t.unref();
  });
  return Promise.race([Promise.resolve(p).finally(() => { if (t) clearTimeout(t); }), timeout])
    .catch((e) => ({ ok: false, error: (e && e.message) || String(e) }))
    .then((res) => {
      if (res && res.__timedOut) {
        registry._log('warn', 'heartbeat 监督超时(' + id + ')：已跳过本拍（防心跳停摆）');
      }
      return res;
    });
}

/** 唯一心跳：遍历目录项，对已挂 adapter 的对象执行 supervise/observe 并写入实然；
 *  本层收集观测（lastObserved）与 derivePhase 的相位收敛（setPhase），启停/退避仍由各类型 adapter 的驱动开关决定。
 *  节流经 tickEvery（1=每拍；daemon 类 6~30s）；单对象异常隔离。 */
async function runHeartbeat(registry, intervalMs) {
  // 归属判断：上一拍未结算时本拍并入（返回同一 promise），不并发监督；
  // 只有持有者清标记，迟到的旧拍不会清掉新拍的标记。
  if (registry._heartbeatInFlight) return registry._heartbeatInFlight;
  const beat = runBeat(registry, intervalMs);
  registry._heartbeatInFlight = beat;
  try {
    return await beat;
  } finally {
    if (registry._heartbeatInFlight === beat) registry._heartbeatInFlight = null;
  }
}

async function runBeat(registry, intervalMs) {
  const iv = intervalMs || 5000;
  const now = Date.now();
  const observed = [];
  const errors = [];
  // 快照遍历：adapter 在 await 期间可能注销对象并 splice _objects，直接迭代活数组会跳过条目
  for (const e of registry._objects.slice()) {
    const ad = registry._adapters[e.kind];
    if (!ad) continue; // 未挂 adapter：不观测（不驱动）
    // 两形态：supervise = 守卫门控的监督单拍（如 daemon）；observe = 纯观测
    const fn = (typeof ad.supervise === 'function') ? ad.supervise : ((typeof ad.observe === 'function') ? ad.observe : null);
    if (!fn) continue;
    const tickEvery = ad.tickEvery || (e.ownership && e.ownership.meta && e.ownership.meta.tickEvery) || 1;
    if (tickEvery > 1) {
      if (e._nextTickAt && now < e._nextTickAt) continue; // 节流（daemon 类 ~6拍/30s）
      // 用本次实际执行时刻前推而非入口 now：循环是串行的，前面对象的耗时会把 now 变陈旧、
      // 节流窗被系统性拉长。
      e._nextTickAt = Date.now() + tickEvery * iv;
    }
    try {
      // 每对象加超时：心跳是 main 收敛/沙箱监督/daemon 监督的唯一周期驱动，且 supervisor
      // 以 _heartbeatBusy 防重叠——一个永不 settle 的 adapter 会让心跳永停。
      // 超时按异常处理（记 errors + 落 {ok:false} 观测），循环继续推进。
      const res = await withTimeout(registry, fn(e), iv * ADAPTER_TIMEOUT_TICKS, e.id);
      // 超时必须进 errors 汇总，否则调用方只看 errors/observed 会以为一切正常
      if (res && res.__timedOut) errors.push(e.id + ':' + (res.error || '监督超时'));
      if (res && typeof res.ok === 'boolean') {
        // await 期间条目可能已注销/被同 id 新对象替换：非当前登记项不得回写实然
        if (registry.get(e.id) !== e) continue;
        registry.applyObservation(e.id, res);
        // derivePhase（daemon 类）：phase 由应然与观测收敛——期望 running 且在线=running，
        // 否则 stopped；防止「daemon desired=running 但 phase 恒 stopped」误导目录。
        if (ad.derivePhase === true) {
          const want = e.desired === 'running';
          const p = (want && res.ok) ? 'running' : 'stopped';
          if (e.phase !== p) registry.setPhase(e.id, p);
        }
      }
      observed.push(e.id);
    } catch (err) {
      errors.push(e.id + ':' + ((err && err.message) || err));
      registry._log('warn', 'heartbeat ' + (ad.supervise ? 'supervise' : 'observe') + '(' + e.kind + ':' + e.id + '): ' + ((err && err.message) || err));
    }
  }
  // 拍末钩子（B2-6e）：需要「每心跳拍恰好一次」的全局决策（如 governor 全花名册 decide）挂这里，
  // 与监督同源、不经逐实例 adapter，避免 N 实例把决策乘法放大成 O(N^2)。异常隔离：钩子失败不断心跳。
  if (typeof registry.onBeatDone === 'function') {
    try { await registry.onBeatDone({ observed, errors }); }
    catch (err) { registry._log('warn', 'heartbeat onBeatDone: ' + ((err && err.message) || err)); }
  }
  return { observed, errors };
}

module.exports = { runHeartbeat, withTimeout, ADAPTER_TIMEOUT_TICKS };
