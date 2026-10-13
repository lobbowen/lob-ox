'use strict';


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
      if (host.lanDaemonEnabled()) { host._syncLanState(); return; }
      host.lan.instanceStart(inst).catch((e) => host.logger.warn && host.logger.warn('lan instanceStart: ' + e.message));
    };
    host.instances.onInstanceStop = (inst) => {
      if (host.lanDaemonEnabled()) { host._syncLanState(); return; }
      try { host.lan.instanceStop(inst); } catch (e) { host.logger.warn && host.logger.warn('lan stop: ' + e.message); }
    };
}

module.exports = { composeObservers };
