'use strict';

// relay 监听服务生命周期（relay 域 ops 叶子）：操作显式传入 host（LanManager 实例），无隐式 this。
// 依赖：proxy（createRelay 服务本体）、ports（端口释放）；frpc 停止经 host.frp。

const { createRelay } = require('../proxy');
const portsvc = require('../ports');

function startLanServer(host, inst) {
  host._lanServers = host._lanServers || {};
  if (host._lanServers[inst.id]) return;
  if (!inst.wanPort) return; // wanPort 被清（监听失败待迁移）：等待 syncProxy 重新分配
  // 防同端口双监听：若该 wanPort 已有 server（其他实例）则跳过（端口冲突保护）。
  for (const id of Object.keys(host._lanServers)) {
    if (id === inst.id) continue;
    const p = host.lanInstances.find((x) => x.id === id);
    if (p && p.wanPort === inst.wanPort) {
      host.logger.warn && host.logger.warn('wanPort ' + inst.wanPort + ' 已被 ' + id + ' 占用，跳过 ' + inst.id);
      return;
    }
  }
  const server = createRelay('127.0.0.1', inst.dshPort, {
    id: inst.id,
    token: inst.token || '',
    dshTokenOf: () => host.tokenOf(inst.id) || '', // 传按需读取函数而非令牌值
    logger: host.logger,
    events: host.events,
  });
  server.on('error', (err) => {
    host.logger.warn && host.logger.warn('lan relay error (' + inst.id + '): ' + err.message);
    delete host._lanServers[inst.id];
    // EADDRINUSE：释放绑定并节流迁移一次，避免 reconcile 每 tick 无限重试刷日志。
    if (err.code === 'EADDRINUSE') handleRelayListenFail(host, inst);
  });
  server.listen(inst.wanPort, '0.0.0.0', () => {
    host._lanServers[inst.id] = server;
    if (host.events) host.events.append('lan_instance_started', { id: inst.id, wanPort: inst.wanPort, dshPort: inst.dshPort });
    host.logger.info && host.logger.info('lan ' + inst.name + ' on 0.0.0.0:' + inst.wanPort + ' -> 127.0.0.1:' + inst.dshPort);
  });
  host._lanServers[inst.id] = server;
}

/** 监听失败（EADDRINUSE）：释放端口绑定并节流（60s/实例），下轮 reconcile 重新分配迁移。 */
function handleRelayListenFail(host, inst) {
  const now = Date.now();
  host._relayFailThrottle = host._relayFailThrottle || {};
  const last = host._relayFailThrottle[inst.id] || 0;
  if (now - last < 60000) return; // 60s 节流：不每 tick 迁移
  host._relayFailThrottle[inst.id] = now;
  portsvc.releaseOwner('relay:' + inst.id);
  // 清派生缓存条目的 wanPort（条目即 inst 本体），交由 syncProxy 重新分配新端口。
  const proxy = host.lanInstances.find((p) => p.id === inst.id);
  if (proxy) proxy.wanPort = null;
  if (host.logger && host.logger.warn) host.logger.warn('[relay] ' + inst.id + ' 端口监听失败，已释放绑定，将迁移新端口');
  if (host.events) host.events.append('lan_relay_listen_failed', { id: inst.id });
}

function stopLanServer(host, id) {
  const server = host._lanServers && host._lanServers[id];
  if (!server) return;
  try { server.close(() => {}); } catch {}
  // 关闭监听后主动断开既有连接：否则长 WS 隧道会让端口滞留，重建时 EADDRINUSE。
  try { if (typeof server.closeAllConnections === 'function') server.closeAllConnections(); } catch {}
  delete host._lanServers[id];
  if (host.events) host.events.append('lan_instance_stopped', { id });
}

/** 守卫优雅退出时调用：停止全部 relay 与 frpc（防守卫重启后孤儿/双实例）。 */
function shutdown(host) {
  try {
    for (const id of Object.keys(host._lanServers || {})) stopLanServer(host, id);
  } catch (e) { host.logger.warn && host.logger.warn('lan shutdown relays: ' + e.message); }
  try {
    if (host.frp) { const r = host.frp.stop(); if (r && r.already) host.frp._cleanupOrphans && host.frp._cleanupOrphans(); }
  } catch (e) { host.logger.warn && host.logger.warn('lan shutdown frpc: ' + e.message); }
}

/** 令牌变化的下发端（由 tokenService.onChange 调用）：热换既有 relay 的 DSH 会话 cookie；本域不持令牌副本。 */
function applyToken(host, instId) {
  if (!instId) return false;
  const proxy = host.lanInstances.find((p) => p.id === instId);
  const server = proxy && host._lanServers && host._lanServers[proxy.id];
  if (server && typeof server.setDshToken === 'function') {
    server.setDshToken();
    if (host.events) host.events.append('lan_dsh_token_updated', { id: instId });
  }
  return !!server;
}

module.exports = { startLanServer, stopLanServer, shutdown, applyToken };
