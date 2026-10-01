'use strict';

const { registerAll } = require('../../../app/control/adapters');

function composeObservers(host) {
    host.instances.onRemoteChange = (inst) => {
      if (host.lanDaemonEnabled()) { host._syncLanState(); return; }
      host.lan.syncProxy(inst).catch((e) => host.logger.warn && host.logger.warn('lan syncProxy: ' + e.message));
    };
    host.instances.onRemove = (id) => {
      if (host.lanDaemonEnabled()) { host._syncLanState(); return; }
      host.lan.removeProxyForInstance(id).catch((e) => host.logger.warn && host.logger.warn('lan removeProxy: ' + e.message));
    };
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
    try {
      registerAll(host.lifecycleManager, {
        router: host.router, lan: host.lan, instances: host.instances,
        supervisor: host, pluginManager: host.pluginManager, logger: host.logger,
      });
      if (host.logger && host.logger.info) host.logger.info('[lifecycle] 已注册模块: ' + host.lifecycleManager.all().map((l) => l.id).join(','));
      host._syncDshLifecycleView();
      try { host._syncInstancesLifecycleView(); } catch (e) {}
    } catch (e) { host.logger.warn && host.logger.warn('[lifecycle] 注册失败: ' + (e && e.message)); }
}

module.exports = { composeObservers };
