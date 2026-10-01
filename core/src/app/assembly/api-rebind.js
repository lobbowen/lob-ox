'use strict';

const portsShared = require('../../platform/service/ports').shared;

function _rebindApiHost(host, createServer) {
    const old = host.api;
    if (old) {
      try { old.close(); } catch {}
      try { if (typeof old.closeAllConnections === 'function') old.closeAllConnections(); } catch {}
    }
    const bind = () => {
      if (bind._slowRetry && typeof host._exitIntended === 'function' && host._exitIntended()) {
        bind._slowRetry = false;
        host.logger.warn('api rebind 中止：检测到退出意图');
        return;
      }
      const server = createServer(host);
      server.on('error', (err) => {
        const transient = err && (err.code === 'EADDRINUSE' || err.code === 'EADDRNOTAVAIL');
        if (transient) {
          const tries = bind._tries || 0;
          if (tries < 10) {
            bind._tries = tries + 1;
            setTimeout(bind, 300);
          } else {
            bind._tries = 0;
            bind._slowRetry = true;
            setTimeout(bind, 30000);
            host.events.append('api_error', { message: 'API 重绑端口持续被占用/不可用，30s 后自动重试: ' + err.message });
            host.logger.error('api rebind degraded (30s slow retry): ' + err.message);
          }
          return;
        }
        if (err && err.code === 'EACCES') {
          host.events.append('api_offline', { message: 'API 绑定被拒（权限不足，不重试）: ' + err.message, code: err.code });
          host.logger.error('api offline (EACCES, not retryable): ' + err.message);
          return;
        }
        host.events.append('api_error', { message: '未知监听错误，30s 后自动重试: ' + err.message });
        host.logger.error('api error (retry in 30s): ' + err.message);
        bind._slowRetry = true;
        setTimeout(bind, 30000);
      });
      server.listen(host.config.apiPort, host.config.apiHost, () => {
        bind._tries = 0;
        host.api = server;
        try { portsShared.registerSole('supervisor-api', host.config.apiPort); } catch (e) { host.logger.warn('ports.registerSole(supervisor-api) 失败: ' + ((e && e.message) || e)); }
        host.events.append('api_listening', { host: host.config.apiHost, port: host.config.apiPort });
        host.logger.info('api listening on ' + host.config.apiHost + ':' + host.config.apiPort);
      });
    };
    bind._tries = 0;
    host.api = null;
    bind();
}

function startApi(host, createServer) {
  const maxSkew = 50;
  const attempt = (port, skew) => {
    const server = createServer(host);
    server.on('error', (err) => {
      if (err && err.code === 'EADDRINUSE' && skew < maxSkew) {
        const next = host.config.apiPort + skew + 1;
        host.events.append('api_port_skew', { from: host.config.apiPort, to: next, reason: err.message });
        host.logger.warn('api port ' + port + ' occupied, trying ' + next + ': ' + err.message);
        return attempt(next, skew + 1);
      }
      host.events.append('api_error', { message: err ? err.message : String(err) });
      host.logger.error('api error: ' + (err ? err.message : String(err)));
    });
    server.listen(port, host.config.apiHost, () => {
      host.api = server;
      const prev = host.config.apiPort;
      if (port !== prev) {
        host.config.apiPort = port;
        if (host.configPath) host.persistConfigPatch({ apiPort: port });
      }
      try { portsShared.registerSole('supervisor-api', port); } catch (e) { host.logger.warn('ports.registerSole(supervisor-api) 失败: ' + e.message); }
      host.events.append('api_listening', { host: host.config.apiHost, port });
      host.logger.info('api listening on ' + host.config.apiHost + ':' + port);
    });
    return server;
  };
  host.api = attempt(host.config.apiPort, 0);
  }

module.exports = { _rebindApiHost, startApi };
