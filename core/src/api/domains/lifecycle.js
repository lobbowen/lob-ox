'use strict';

// 域：统一生命周期 API（status/lifecycle/healthz/readyz/events）。
const { isInternalEvent } = require('../../platform/service/log/hub');

// main 启停唯一入口 /lifecycle/dsh/{start|stop|restart}。
function owns(pathname) {
  return pathname === '/status' || pathname.startsWith('/lifecycle') || pathname === '/healthz' || pathname === '/readyz' || pathname === '/events' || pathname.startsWith('/logs') || pathname === '/metrics' || pathname === '/session/stop' || pathname === '/session/status';
}

function handle(ctx) {
  const { sup, req, pathname, send, originAllowed } = ctx;

    if (req.method === 'GET' && pathname === '/status') {
      return send(200, sup.statusSummary());
    }

    // 会话生命周期：GET /session/status 为会话态唯一读取口（INV-S4）；
    // POST /session/stop 进入 stopping、停全部被管对象后置 stopped 并回执（INV-S2）。
    // 守卫不停止自己；壳收到本回执后执行 systemctl --user stop。
    if (req.method === 'GET' && pathname === '/session/status') {
      return send(200, { sessionState: sup.sessionState ? sup.sessionState() : 'unknown' });
    }
    if (req.method === 'POST' && pathname === '/session/stop') {
      if (!originAllowed(req, sup.config.apiPort)) { req.resume(); return send(403, { ok: false, error: 'cross-origin request rejected' }); }
      req.resume();
      return Promise.resolve(sup.shutdownAll())
        .then((r) => send(r && r.ok === false ? 400 : 200, r || { ok: true }))
        .catch((e) => send(500, { ok: false, error: e.message }));
    }

    // 统一生命周期接口：所有模块生命周期经此（status 一览 / {id} 单查 / {id}/start|stop|restart），
    // 前端一律不直调模块对象。
    if (pathname === '/lifecycle' || pathname === '/lifecycle/status') {
      const lm = sup.lifecycleManager;
      return send(200, lm ? { modules: lm.statusAll() } : { modules: [] });
    }
    if (pathname.startsWith('/lifecycle/')) {
      const lm = sup.lifecycleManager;
      if (!lm) return send(503, { error: 'lifecycleManager 未初始化' });
      const rest = pathname.slice('/lifecycle/'.length);
      const parts = rest.split('/');
      const id = parts[0]; // 已由分派器统一安全解码（畸形编码 400），域内不得再 decode
      const action = parts[1] || null;
      if (req.method === 'GET' && !action) {
        const lc = lm.get(id);
        return lc ? send(200, lc.snapshot()) : send(404, { error: '模块未注册: ' + id });
      }
      if (req.method === 'POST' && action) {
        // 写动作统一经本入口，Origin 门禁在此。
        if (!originAllowed(req, sup.config.apiPort)) { req.resume(); return send(403, { ok: false, error: 'cross-origin request rejected' }); }
        const lc = lm.get(id);
        if (!lc) return send(404, { error: '模块未注册: ' + id });
        // main(dsh) 启停收敛到统一生命周期入口：经 lm -> adapter dsh 的 start/stop -> setDesired/requestRestart，
        // 动作申报进 lifecycleManager（审计/事件），响应形状经 statusSummary 补 desired/phase 保持一致。
        if (id === 'dsh' && sup && (action === 'start' || action === 'stop' || action === 'restart')) {
          const act = action === 'start' ? lm.start(id)
            : action === 'stop' ? lm.stop(id, 'user')
            : lm.restart(id);
          return act.then((r) => {
            if (r && r.error) return send(409, { ok: false, error: r.error });
            const snap = sup.statusSummary ? sup.statusSummary() : {};
            return send(200, { ok: r.ok !== false, desired: snap.desired || sup.desired, phase: snap.phase || sup.phase });
          }).catch((e) => send(500, { error: e.message }));
        }
        if (action === 'start') { lm.start(id).then((r) => send(r.ok === false ? 409 : 200, r)).catch((e) => send(500, { error: e.message })); return; }
        if (action === 'stop') { lm.stop(id, 'user').then((r) => send(r.ok === false ? 409 : 200, r)).catch((e) => send(500, { error: e.message })); return; }
        if (action === 'restart') { lm.restart(id).then((r) => send(r && r.ok === false ? 409 : 200, r)).catch((e) => send(500, { error: e.message })); return; } // 不可启停模块 409 而非 200
        return send(400, { error: '未知动作: ' + action + '（start|stop|restart）' });
      }
      return send(400, { error: '非法请求' });
    }

    // 健康 / readiness
    if (req.method === 'GET' && pathname === '/healthz') {
      return send(200, sup.health ? sup.health.live() : { ok: true, pid: process.pid });
    }
    if (req.method === 'GET' && pathname === '/readyz') {
      return send(200, sup.health ? sup.health.ready() : { ok: true, ready: true });
    }

    if (req.method === 'GET' && pathname === '/events') {
      let after = 0;
      let limit = 50;
      let filter = null;
      let showInternal = false;
      try {
        const u = new URL(req.url, 'http://localhost');
        after = Math.max(Number(u.searchParams.get('after') || 0) || 0, 0);
        limit = Math.min(Math.max(Number(u.searchParams.get('limit') || 50) || 50, 1), 500);
        showInternal = u.searchParams.get('internal') === '1' || u.searchParams.get('internal') === 'true';
        const src = u.searchParams.get('source');
        const typ = u.searchParams.get('type');
        if (src || typ) filter = { source: src || undefined, type: typ || undefined };
      } catch {}
      // /events 读守卫 EventHub 聚合流（gseq 全局有序、跨守卫重启连续）；sup.eventHub 为真实
      // EventHub 或 EventReader 降级适配器，同接口同语义。
      // 默认过滤内部簿记事件（heartbeat 影子 shadow_* / 注册机 managed_object_*，聚合时打 internal 标），
      // 它们只进审计（internal=1 / /logs/export），UI 时间线只显示业务事件。
      const hub = sup.eventHub;
      if (!hub) return send(200, { seq: (sup.events && sup.events.seq) || 0, events: [] });
      const seq = hub.seq;
      let list = [];
      if (showInternal) {
        list = filter ? hub.readFiltered(filter, after, limit) : hub.read(after, limit);
      } else if (filter) {
        // 检索也排除内部簿记（审计用 internal=1 / /logs/export）
        list = hub.readFiltered(filter, after, limit).filter((e) => (e.internal === undefined ? !isInternalEvent(e && e.type) : !e.internal));
      } else {
        // 用户时间线：全窗过滤 internal 后取尾，避免『先 limit 后过滤，被内部事件挤空』
        list = hub.readVisible(after, limit);
      }
      return send(200, { seq, events: list });
    }

    // /logs/tail?stream=guard|router|lan|dsh|upgrade&n= 排障日志尾部。
    if (req.method === 'GET' && pathname === '/logs/tail') {
      const u = new URL(req.url, 'http://localhost');
      const stream = u.searchParams.get('stream') || 'guard';
      const n = Math.min(Math.max(Number(u.searchParams.get('n') || 100) || 100, 1), 2000);
      return send(200, { stream, lines: sup.eventHub ? sup.eventHub.tailLog(stream, n) : [] });
    }
    // /logs/export?after=&limit= 审计导出（聚合流 JSONL 原文，离线备份）。
    if (req.method === 'GET' && pathname === '/logs/export') {
      const u = new URL(req.url, 'http://localhost');
      const after = Math.max(Number(u.searchParams.get('after') || 0) || 0, 0);
      const limit = Math.min(Math.max(Number(u.searchParams.get('limit') || 2000) || 2000, 1), 20000);
      const lines = sup.eventHub.exportLines(after, limit);
      return send(200, { seq: sup.eventHub.seq, exported: lines.length, lines });
    }

    // /metrics 遥测（事件流派生只读投影，不新增采集通道）。
    if (req.method === 'GET' && pathname === '/metrics') {
      if (!sup.eventHub) return send(200, { gseq: 0, events: 0, bySource: {}, topTypes: [], sinceLastMs: null, ts: new Date().toISOString() });
      return send(200, sup.eventHub.metrics());
    }

  // 域内未匹配(方法/子路径)：全局兜底语义
  if (req.method === 'GET' || req.method === 'POST') return send(404, { error: 'not found', path: pathname });
  return send(405, { error: 'method not allowed' });
}

module.exports = { owns, handle };
