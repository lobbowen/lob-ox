'use strict';

const portsShared = require('../../platform/service/ports').shared;

// app/assembly/api-rebind.js —— HTTP 监听的启动与主机重绑（面板切换「局域网访问」）。
// createServer 由 root 在装配时注入：本层若直接 require api 就构成 app -> api 越界（契约 DS-3）。

function _rebindApiHost(host, createServer) {
    const old = host.api;
    if (old) {
      try { old.close(); } catch {}
      try { if (typeof old.closeAllConnections === 'function') old.closeAllConnections(); } catch {}
    }
    const bind = () => {
      // 慢重试是跨 30s 的自愈链，有退出意图即就地终止
      //   （否则守卫关停后仍会重开监听器）。首绑不经此闸（hostFirst 装配期 _exitIntended 未必就绪）。
      if (bind._slowRetry && typeof host._exitIntended === 'function' && host._exitIntended()) {
        bind._slowRetry = false;
        host.logger.warn('api rebind 中止：检测到退出意图');
        return;
      }
      const server = createServer(host);
      server.on('error', (err) => {
        // 监听错误按「能否由重试消解」分类，不许有静默分支（API 永久下线比端口冲突更糟）：
        //   EADDRINUSE/EADDRNOTAVAIL 属瞬时，进快慢重试环；EACCES 重试不可消解，只发一次
        //   api_offline 且不空转，host.api 保持 null 如实呈现下线。
        const transient = err && (err.code === 'EADDRINUSE' || err.code === 'EADDRNOTAVAIL');
        if (transient) {
          // 端口仍被旧连接占用：短暂等待后重试；10 次后降级为 30s 慢重试（持续自愈，绝不永久下线）
          const tries = bind._tries || 0;
          if (tries < 10) {
            bind._tries = tries + 1;
            setTimeout(bind, 300);
          } else {
            bind._tries = 0;
            bind._slowRetry = true; // 标记进入慢自愈环，下一拍先过退出意图闸
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
        // 未知监听错误：保守按瞬时处理进入自愈环（含退出意图闸），并留 api_error 痕迹。
        host.events.append('api_error', { message: '未知监听错误，30s 后自动重试: ' + err.message });
        host.logger.error('api error (retry in 30s): ' + err.message);
        bind._slowRetry = true;
        setTimeout(bind, 30000);
      });
      server.listen(host.config.apiPort, host.config.apiHost, () => {
        bind._tries = 0;
        host.api = server;
        // 重绑成功后同样登记实际端口（D3），并清除同 role 的旧端口记录。
        try { portsShared.registerSole('supervisor-api', host.config.apiPort); } catch (e) { host.logger.warn('ports.registerSole(supervisor-api) 失败: ' + ((e && e.message) || e)); }
        host.events.append('api_listening', { host: host.config.apiHost, port: host.config.apiPort });
        host.logger.info('api listening on ' + host.config.apiHost + ':' + host.config.apiPort);
      });
    };
    bind._tries = 0;
    host.api = null;
    bind();
}

  /** 启动 HTTP API 服务（端口被占时向后避让，最多 maxSkew 次）。 */
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
      // 登记实际绑定端口：KERNEL-DAEMON-CONTRACT D3，壳的唯一就绪判据。
      //   registerSole 而非 register：避让成功时旧端口的登记必须一并消失（ports.json 留两条
      //   supervisor-api 时壳取最新一条，但内核自己的 ports.get(role) 与池统计都会看成两回事）。
      try { portsShared.registerSole('supervisor-api', port); } catch (e) { host.logger.warn('ports.registerSole(supervisor-api) 失败: ' + e.message); }
      host.events.append('api_listening', { host: host.config.apiHost, port });
      host.logger.info('api listening on ' + host.config.apiHost + ':' + port);
    });
    return server;
  };
  host.api = attempt(host.config.apiPort, 0);
  }


module.exports = { _rebindApiHost, startApi };
