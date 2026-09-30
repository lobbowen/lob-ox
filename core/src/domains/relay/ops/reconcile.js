'use strict';

// 远程代理对账与实例联动（relay 域 ops 叶子）：操作用例显式传入 host（LanManager 实例），无隐式 this。
// 依赖：ports（端口登记）、monitor（TCP 探活）。

const portsvc = require('../ports');
const monitor = require('../../../platform/service/monitor');

/** 目标实例是否可达（TCP 直连探测，跨平台可靠）。 */
async function targetReachable(inst) {
  if (!inst || !inst.port) return false;
  const host = inst.host || '127.0.0.1';
  return monitor.isPortListening(host, inst.port, 600);
}

/** syncProxy 串行队列：claim 是异步的（含探测/回收），并发调用会同时通过检查并拿到同一 wanPort。 */
function syncProxyQueued(host, inst) {
  const run = host._proxyChain = host._proxyChain.then(() => host.syncProxy(inst)).catch(() => {});
  return run;
}

/** 删除单个代理登记。端口绑定分级：实例已删（stale）释放注册表绑定；仅关远程（disabled）保留绑定，
 *  再开经 claim 按 owner 复用同端口（绑定唯一权威在注册表，实例记录无 wanPort 镜像）。 */
function removeOne(host, proxy, inst) {
  host.logger.warn && host.logger.warn('[reconcile] remove proxy ' + proxy.id + ' wanPort=' + proxy.wanPort
    + ' (inst=' + !!inst + ' remoteMode=' + (inst && inst.remoteMode) + ')');
  if (host._lanServers && host._lanServers[proxy.id]) host._stopLanServer(proxy.id);
  if (!inst) portsvc.releaseOwner('relay:' + proxy.id);
  if (host.events) host.events.append('lan_instance_removed', { id: proxy.id, reason: !inst ? 'stale' : 'disabled' });
}

/** relay 运行 = 目标存活：up 则确保在监听，down 则停 relay（保留注册）。
 *  令牌/模式漂移必须在这里复判：main 无 onRemoteChange 钩子、daemon 侧只靠状态文件，热换钩子可能丢变更，
 *  reconcile 是唯一兜底收敛点——比对代理缓存与实例现值，漂移即重走 syncProxy（快路径负责 setToken + mode 收敛）。 */
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

/** 剔除孤儿/关闭远程的代理；返回是否发生移除。 */
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

/** 确保 remoteMode!=off 的实例都有代理注册（新开远程/新实例；串行防竞态）。 */
function ensureRegistrations(host, insts) {
  for (const inst of insts) {
    if ((inst.remoteMode === 'lan' || inst.remoteMode === 'wan') && !host.lanInstances.some((p) => p.dshPort === inst.port)) {
      syncProxyQueued(host, inst).catch((e) => host.logger.warn && host.logger.warn('reconcile syncProxy ' + inst.id + ': ' + e.message));
    }
  }
}

/** 对账主体（由 reconcile 单飞包装调用；不直接外部调用）。 */
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
  portsvc.releaseOwner('relay:' + instId); // 实例删除：端口随对象释放
  if (host.events) host.events.append('lan_instance_removed', { id: instId });
  host.syncFrpc();
}

/** 实例启动时联动远程代理：remoteMode!=off 且实例在跑时确保对应 relay 在监听。 */
async function instanceStart(host, inst) {
  if (!inst || !inst.port || (inst.remoteMode !== 'lan' && inst.remoteMode !== 'wan')) return;
  const existing = host.lanInstances.find((p) => p.dshPort === inst.port);
  if (existing) host._startLanServer(existing);
  else await syncProxyQueued(host, inst);
}

/** 实例停止时联动远程代理：停止对应 relay（保留 lanInstances 注册，便于再次启动）。 */
function instanceStop(host, inst) {
  if (!inst || !inst.port) return;
  const proxy = host.lanInstances.find((p) => p.dshPort === inst.port);
  if (proxy) host._stopLanServer(proxy.id);
}

module.exports = { targetReachable, syncProxyQueued, reconcileOnce, removeProxyForInstance, instanceStart, instanceStop };
