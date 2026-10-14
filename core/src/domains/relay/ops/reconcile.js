'use strict';

const portsvc = require('../ports');
const monitor = require('../../../platform/service/monitor');

async function targetReachable(inst) {
  if (!inst || !inst.port) return false;
  const host = inst.host || '127.0.0.1';
  return monitor.isPortListening(host, inst.port, 600);
}

function syncProxyQueued(host, inst) {
  const run = host._proxyChain = host._proxyChain.then(() => host.syncProxy(inst)).catch(() => {});
  return run;
}

function removeOne(host, proxy, inst) {
  host.logger.warn && host.logger.warn('[reconcile] remove proxy ' + proxy.id + ' wanPort=' + proxy.wanPort
    + ' (inst=' + !!inst + ' remoteMode=' + (inst && inst.remoteMode) + ')');
  if (host._lanServers && host._lanServers[proxy.id]) host._stopLanServer(proxy.id);
  if (!inst) portsvc.releaseOwner('relay:' + proxy.id);
  if (host.events) host.events.append('lan_instance_removed', { id: proxy.id, reason: !inst ? 'stale' : 'disabled' });
}

async function ensureProxyRunning(host, proxy, inst) {
  const wantToken = String(inst.remoteToken || '');
  const wantMode = inst.remoteMode === 'lan' || inst.remoteMode === 'wan' ? inst.remoteMode : 'off';
  const drifted = proxy.token !== wantToken || proxy.remoteMode !== wantMode;
  if (drifted && proxy.wanPort) {
    syncProxyQueued(host, inst).catch((e) => host.logger.warn && host.logger.warn('reconcile resync ' + inst.id + ': ' + e.message));
    return;
  }
  const targetAlive = await targetReachable(inst);
  const running = !!(host._lanServers && host._lanServers[proxy.id]);
  if (targetAlive && !running) {
    if (!proxy.wanPort) {
      syncProxyQueued(host, inst).catch((e) => host.logger.warn && host.logger.warn('reconcile syncProxy ' + inst.id + ': ' + e.message));
    } else {
      host._startLanServer(proxy);
    }
  } else if (!targetAlive && running) {
    host._stopLanServer(proxy.id);
  }
}

async function removeStaleProxies(host, insts) {
  let removed = false;
  const kept = [];
  for (const proxy of host.lanInstances) {
    const inst = insts.find((i) => i.port === proxy.dshPort);
    if (!inst || (inst.remoteMode !== 'lan' && inst.remoteMode !== 'wan')) {
      removeOne(host, proxy, inst);
      removed = true;
    } else {
      kept.push(proxy);
      await ensureProxyRunning(host, proxy, inst);
    }
  }
  if (removed) host.lanInstances = kept;
  return removed;
}

function ensureRegistrations(host, insts) {
  for (const inst of insts) {
    if ((inst.remoteMode === 'lan' || inst.remoteMode === 'wan') && !host.lanInstances.some((p) => p.dshPort === inst.port)) {
      syncProxyQueued(host, inst).catch((e) => host.logger.warn && host.logger.warn('reconcile syncProxy ' + inst.id + ': ' + e.message));
    }
  }
}

async function reconcileOnce(host) {
  try {
    const insts = host._allManaged();
    const removed = await removeStaleProxies(host, insts);
    if (removed) {
      host.syncFrpc();
      if (host.logger && host.logger.info) host.logger.info('reconcile lan proxies: removed disabled/stale (' + host.lanInstances.length + ' kept)');
    }
    ensureRegistrations(host, insts);
  } catch (e) {
    if (host.logger && host.logger.warn) host.logger.warn('reconcile: ' + e.message);
  }
}

async function removeProxyForInstance(host, instId) {
  const proxy = host.lanInstances.find((p) => p.id === instId);
  if (!proxy) return;
  host._stopLanServer(proxy.id);
  host.lanInstances = host.lanInstances.filter((p) => p.id !== instId);
  portsvc.releaseOwner('relay:' + instId);
  if (host.events) host.events.append('lan_instance_removed', { id: instId });
  host.syncFrpc();
}

async function instanceStart(host, inst) {
  if (!inst || !inst.port || (inst.remoteMode !== 'lan' && inst.remoteMode !== 'wan')) return;
  const existing = host.lanInstances.find((p) => p.dshPort === inst.port);
  if (existing) host._startLanServer(existing);
  else await syncProxyQueued(host, inst);
}

function instanceStop(host, inst) {
  if (!inst || !inst.port) return;
  const proxy = host.lanInstances.find((p) => p.dshPort === inst.port);
  if (proxy) host._stopLanServer(proxy.id);
}

module.exports = { targetReachable, syncProxyQueued, reconcileOnce, removeProxyForInstance, instanceStart, instanceStop };
