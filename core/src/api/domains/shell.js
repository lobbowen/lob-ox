'use strict';

// 域：桌面壳更新安全网 API（/shell/*）。端点只回环可达（壳在本机，与既有 API 信任模型一致，identity.js socket 层判定）；
// 写操作（health/update-pending/check-update/restart）走 originAllowed 同源校验（与 dist/relay 同规）。
// 内核不含「更新源」职责（壳直连 npm CDN，故无 /shell/update/check），壳更新强制且不可回退（无 /shell/rollback）。
function owns(pathname) {
  return pathname === '/shell/status' || pathname.startsWith('/shell/');
}

function handle(ctx) {
  const { sup, req, res, pathname, send, collectBody, originAllowed } = ctx;
  const shell = sup.shellDomain;
  if (!shell) { return send(503, { ok: false, error: '壳安全网未初始化' }); }

  // 状态：壳身份 + 更新账本 + 判定结果（面板/CLI 消费）
  if (req.method === 'GET' && pathname === '/shell/status') {
    try { return send(200, Object.assign({ ok: true }, shell.status())); }
    catch (e) { return send(500, { ok: false, error: e.message }); }
  }

  // 健康上报：壳启动各阶段调用；phase=ready 即更新确认信号
  if (req.method === 'POST' && pathname === '/shell/health') {
    if (!originAllowed(req, sup.config.apiPort)) { req.resume(); return send(403, {}); }
    return collectBody(req, res, 8192, (body) => {
      let j = {};
      try { j = body ? JSON.parse(body) : {}; } catch {}
      try { return send(200, shell.health(j)); }
      catch (e) { return send(500, { ok: false, error: e.message }); }
    });
  }

  // 更新待确认：壳安装完成、重启前告知内核（内核据此建立账本）
  if (req.method === 'POST' && pathname === '/shell/update-pending') {
    if (!originAllowed(req, sup.config.apiPort)) { req.resume(); return send(403, {}); }
    return collectBody(req, res, 8192, (body) => {
      let j = {};
      try { j = body ? JSON.parse(body) : {}; } catch {}
      try {
        const rec = shell.markPending(j.from || null, j.to || null);
        if (sup.events) sup.events.append('shell_update_pending', { from: rec.from, to: rec.to });
        return send(200, { ok: true, journal: rec });
      } catch (e) { return send(500, { ok: false, error: e.message }); }
    });
  }

  // 壳版本检测（与内核自更新同源：npm registry + 镜像回退）。
  // 面板「检查更新」对内核与桌面壳一起检测，本端点提供壳那一半。
  // 内核不是壳的更新源；此处只查版本，安装仍由壳的门 0 完成。
  if (req.method === 'POST' && pathname === '/shell/check-update') {
    if (!originAllowed(req, sup.config.apiPort)) { req.resume(); return send(403, {}); }
    req.resume();
    return Promise.resolve(shell.checkUpdate(sup.dist, { authoritative: true }))
      .then((r) => {
        if (sup.events) {
          sup.events.append('shell_update_checked', { installed: r.installed, latest: r.latest, updateAvailable: r.updateAvailable });
        }
        return send(200, r);
      })
      .catch((e) => send(500, { ok: false, error: e.message }));
  }

  // 重启桌面壳以应用壳更新：让壳重新启动一次，门 0 在新进程里完成检测/下载/验签/安装。
  if (req.method === 'POST' && pathname === '/shell/restart') {
    if (!originAllowed(req, sup.config.apiPort)) { req.resume(); return send(403, {}); }
    // 会话门：退出中/已退出绝不允许重启桌面壳 —— 否则「退出」被推翻。
    if (typeof sup._sessionHalting === 'function' && sup._sessionHalting()) {
      req.resume();
      return send(409, { ok: false, error: '会话已退出/退出中，拒绝重启桌面壳' });
    }
    req.resume();
    return Promise.resolve(shell.restartShell({
      shouldAbort: () => (typeof sup._sessionHalting === 'function' && sup._sessionHalting()),
    }))
      .then((r) => {
        if (sup.events) sup.events.append('shell_restart_requested', { ok: r.ok, killed: r.killed || [], pid: r.pid || null });
        return send(r.ok ? 200 : 500, r);
      })
      .catch((e) => send(500, { ok: false, error: e.message }));
  }

  if (req.method === 'GET' || req.method === 'POST') return send(404, { error: 'not found', path: pathname });
  return send(405, { error: 'method not allowed' });
}

module.exports = { owns, handle };
