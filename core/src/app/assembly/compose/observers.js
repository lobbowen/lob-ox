'use strict';

// app/assembly/compose/observers.js —— 组装第三步：实例事件桥接（远程代理 / lan-state / 受管目录申报）
//   + 把全部模块注册进 LifecycleManager 并同步视图（必须在 start() 之前完成）。
const { registerAll } = require('../../../app/control/adapters');

function composeObservers(host) {
    // 实例事件 -> 远程代理对账。lanDaemon 模式下守卫不在本地建 relay，只把实例清单写进
    //   lan-state.json（daemon 轮询收敛：新增/启停/remoteMode 变化均经 reconcile 处理）。
    host.instances.onRemoteChange = (inst) => {
      if (host.lanDaemonEnabled()) { host._syncLanState(); return; }
      host.lan.syncProxy(inst).catch((e) => host.logger.warn && host.logger.warn('lan syncProxy: ' + e.message));
    };
    host.instances.onRemove = (id) => {
      if (host.lanDaemonEnabled()) { host._syncLanState(); return; }
      host.lan.removeProxyForInstance(id).catch((e) => host.logger.warn && host.logger.warn('lan removeProxy: ' + e.message));
    };
    // 启停联动远程代理：起则确保 relay 在跑、停则停 relay 但保留注册；
    //   同时申报目录（lifecycle 刚写过意图，此处立即把新投影同步进目录，不等下一拍心跳）。
    host.instances.onInstanceStart = (inst) => {
      if (host.managedObjects) { try { host._upsertManaged(host._managedSandboxSpec(inst)); } catch {} }
      if (host.lanDaemonEnabled()) { host._syncLanState(); return; }
      host.lan.instanceStart(inst).catch((e) => host.logger.warn && host.logger.warn('lan instanceStart: ' + e.message));
    };
    host.instances.onInstanceStop = (inst) => {
      if (host.managedObjects) { try { host._upsertManaged(host._managedSandboxSpec(inst)); } catch {} }
      if (host.lanDaemonEnabled()) { host._syncLanState(); return; }
      try { host.lan.instanceStop(inst); } catch (e) { host.logger.warn && host.logger.warn('lan stop: ' + e.message); }
    };
    host.instances.onCreate = (inst) => { if (host.managedObjects) host._upsertManaged(host._managedSandboxSpec(inst)); };
    host.instances.onDestroy = (id) => host._unregisterManaged(id);
    // 模块生命周期注册必须在构造期完成：测试/API 在 start() 之前就会经
    //   lifecycleManager.get('router') 读视图，放到 bootstrap 会让它们拿到 null。
    try {
      registerAll(host.lifecycleManager, {
        router: host.router, lan: host.lan, instances: host.instances,
        supervisor: host, pluginManager: host.pluginManager, logger: host.logger,
      });
      if (host.logger && host.logger.info) host.logger.info('[lifecycle] 已注册模块: ' + host.lifecycleManager.all().map((l) => l.id).join(','));
      host._syncDshLifecycleView();   // 注册后立即同步 DSH 视图（不等首个 tick）
      try { host._syncInstancesLifecycleView(); } catch (e) {}
    } catch (e) { host.logger.warn && host.logger.warn('[lifecycle] 注册失败: ' + (e && e.message)); }
}

module.exports = { composeObservers };
