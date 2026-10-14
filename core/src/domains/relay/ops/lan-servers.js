'use strict';

const { createRelay } = require('../proxy');
const portsvc = require('../ports');
const BRAND = require('../../../shared/brand');

// _lanServers 的成员资格 = listen 已成功。这是「就绪」的唯一事实来源。
// 此前 listen() 之前就先登记条目，于是从登记到回调/错误之间存在一个窗口，
// ops.list() 会把尚未成立的监听报告为 relayListening/running（core.js projectRemoteView 据此判 ready）。
// 监听进程存在但尚未 listening 的中间态由 _lanPending 表达，它不表示就绪。
function isListening(host, id) {
  return !!(host._lanServers && host._lanServers[id]);
}

function startLanServer(host, inst) {
  host._lanServers = host._lanServers || {};
  host._lanPending = host._lanPending || {};
  if (isListening(host, inst.id)) return;
  if (host._lanPending[inst.id]) return;
  if (!inst.wanPort) return;
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
    remoteMode: inst.remoteMode,
    dshTokenOf: () => host.tokenOf(inst.id) || '',
    logger: host.logger,
    events: host.events,
  });
  server.on('error', (err) => {
    host.logger.warn && host.logger.warn('lan relay error (' + inst.id + '): ' + err.message);
    delete host._lanServers[inst.id];
    delete host._lanPending[inst.id];
    if (err.code === 'EADDRINUSE') handleRelayListenFail(host, inst);
  });
  host._lanPending[inst.id] = server;
  server.listen(inst.wanPort, '0.0.0.0', () => {
    host._lanServers[inst.id] = server;
    delete host._lanPending[inst.id];
    if (host.events) host.events.append('lan_instance_started', { id: inst.id, wanPort: inst.wanPort, dshPort: inst.dshPort });
    host.logger.info && host.logger.info('lan ' + inst.name + ' on 0.0.0.0:' + inst.wanPort + ' -> 127.0.0.1:' + inst.dshPort);
  });
}

function handleRelayListenFail(host, inst) {
  const now = Date.now();
  host._relayFailThrottle = host._relayFailThrottle || {};
  const last = host._relayFailThrottle[inst.id] || 0;
  if (now - last < 60000) return;
  host._relayFailThrottle[inst.id] = now;
  portsvc.releaseOwner('relay:' + inst.id);
  const proxy = host.lanInstances.find((p) => p.id === inst.id);
  if (proxy) proxy.wanPort = null;
  if (host.logger && host.logger.warn) host.logger.warn('[relay] ' + inst.id + ' 端口监听失败，已释放绑定，将迁移新端口');
  if (host.events) host.events.append('lan_relay_listen_failed', { id: inst.id });
}

function stopLanServer(host, id) {
  const pending = host._lanPending && host._lanPending[id];
  if (pending) { delete host._lanPending[id]; try { pending.close(() => {}); } catch {} }
  const server = host._lanServers && host._lanServers[id];
  if (!server) return;
  try { server.close(() => {}); } catch {}
  try { if (typeof server.closeAllConnections === 'function') server.closeAllConnections(); } catch {}
  delete host._lanServers[id];
  if (host.events) host.events.append('lan_instance_stopped', { id });
}

function shutdown(host) {
  try {
    for (const id of Object.keys(host._lanServers || {})) stopLanServer(host, id);
  } catch (e) { host.logger.warn && host.logger.warn('lan shutdown relays: ' + e.message); }
  try {
    if (host.frp) { const r = host.frp.stop(); if (r && r.already) host.frp._cleanupOrphans && host.frp._cleanupOrphans(); }
  } catch (e) { host.logger.warn && host.logger.warn('lan shutdown frpc: ' + e.message); }
}

function applyToken(host, instId) {
  if (!instId) return false;
  const proxy = host.lanInstances.find((p) => p.id === instId);
  const server = proxy && host._lanServers && host._lanServers[proxy.id];
  if (server && typeof server.setDshToken === 'function') {
    server.setDshToken();
    if (host.events) host.events.append(BRAND.EVENT_LAN_HARNESS_TOKEN_UPDATED, { id: instId });
  }
  return !!server;
}

module.exports = { startLanServer, stopLanServer, shutdown, applyToken, isListening };
