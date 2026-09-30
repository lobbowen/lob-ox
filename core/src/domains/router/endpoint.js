'use strict';

const https = require('node:https');

// 供应商激活与端点启停 + 请求分派与 HTTP 装配。域内唯一 require('node:http') 并 createServer
// 的地方；转发经注入的 forward.proxyFor，实例保障经注入的 scheduler.ensureProviderInstances，
// 本文件不 require 实现。

const http = require('node:http');
const { readBody } = require('./handlers/parse');

/** 转发用 keep-alive 代理池（门面装配期注入 state；避免把 node:http 带进门面）。 */
function createAgents() {
  return {
    http: new http.Agent({ keepAlive: true, keepAliveMsecs: 30000, maxSockets: 128 }),
    https: new https.Agent({ keepAlive: true, keepAliveMsecs: 30000, maxSockets: 128 }),
  };
}

/** 建 server：超时/keepalive/noDelay 统一规格。 */
function newServer(handler) {
  const server = http.createServer(handler);
  server.requestTimeout = 0;
  server.headersTimeout = 30000;
  server.keepAliveTimeout = 65000;
  server.on('connection', (socket) => { socket.setNoDelay(true); socket.setKeepAlive(true, 15000); });
  return server;
}

function createEndpoint(deps) {
  const d = deps || {};
  const state = d.state;
  const logger = d.logger || null;
  const events = d.events || null;
  const ports = d.ports;
  const forward = d.forward;
  const getProvider = d.getProvider;
  const save = d.save || (() => {});
  const scheduler = d.scheduler;

  /** 供应商独立端点请求处理：按 providerId 作用域转发（该供应商自己的账号池）。 */
  function handleForProvider(providerId, req, res) {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true }));
    }
    const prov = getProvider(providerId);
    if (!prov) { res.writeHead(502, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'provider not found' })); }
    forward.proxyFor(prov, req, res).catch(() => { try { res.end(); } catch {} });
  }

  function log(line) { if (logger && logger.info) logger.info(line); }

  function startProviderServer(id) {
    const p = getProvider(id);
    if (!p || p.activated !== true || !p.apiPort) return;
    if (state.providerServers[id]) return;
    const server = newServer((req, res) => handleForProvider(id, req, res));
    // listen 前先占位，否则并发两次调用都通过上面的 guard，第二次 listen 同端口失败；
    // 且旧 error 处理器按 id 删除会把第一个的登记删掉（登记与进程脱节，close 漏做）。
    state.providerServers[id] = server;
    server.on('error', (err) => {
      log('provider endpoint ' + p.name + ' error: ' + err.message);
      // 仅当登记的仍是本 server 才删除（身份比较），防误删后来者的登记。
      if (state.providerServers[id] === server) delete state.providerServers[id];
    });
    server.listen(p.apiPort, '127.0.0.1', () => {
      if (events) events.append('router_provider_endpoint', { id, name: p.name, port: p.apiPort });
      log('provider endpoint ' + p.name + ' on ' + p.apiPort);
    });
  }

  function stopProviderServer(id) {
    const s = state.providerServers[id];
    if (!s) return;
    delete state.providerServers[id];
    try { s.close(() => {}); if (typeof s.closeAllConnections === 'function') s.closeAllConnections(); } catch {}
  }

  /** 激活供应商：启动其独立 API 端点（未激活不提供服务）。 */
  async function activateProvider(id) {
    const p = getProvider(id);
    if (!p) return { ok: false, error: '供应商不存在' };
    if (!p.activated) {
      p.activated = true;
      // 独立 API 端口：激活时分配（绑定一次防漂移；停用保留，再激活复用）
      if (!p.apiPort) {
        try { p.apiPort = await ports.allocate('providerApi', 'providerApi:' + id); } catch (e) { p.apiPort = null; }
        if (p.apiPort) { try { if (!ports.isRegistered(p.apiPort)) ports.registerUser(p.apiPort, 'providerApi:' + id); } catch {} }
      }
      // 端口池满必须显式失败——绝不静默「激活了但无端点」。
      if (!p.apiPort) {
        p.activated = false;
        const cap = (ports.capacity && ports.capacity().providerApi) || null;
        if (events) { try { events.append('router_provider_activation_failed', { id, name: p.name, error: 'providerApi 端口池耗尽', capacity: cap }); } catch {} }
        return { ok: false, error: 'providerApi 端口池耗尽（' + (cap ? cap.free + ' 空闲 / ' + cap.size + ' 总量' : '满') + '），请扩 portPools.providerApi 或停用部分供应商', poolFull: true, capacity: cap };
      }
      if (p.supports('instanceLifecycle')) scheduler.ensureProviderInstances(p).catch(() => {});
      startProviderServer(id);
      if (events) events.append('router_provider_activated', { id, name: p.name, port: p.apiPort });
      save();
    }
    return { ok: true, id, activated: true, apiPort: p.apiPort };
  }

  /** 停用供应商：关闭独立端点 + 停止其反代实例（资源回收）；apiPort 保留，再激活复用。 */
  function deactivateProvider(id) {
    const p = getProvider(id);
    if (!p) return { ok: false, error: '供应商不存在' };
    if (p.activated) {
      p.activated = false;
      stopProviderServer(id);
      // force=true：停用是资源回收语义；不带 force 时在用实例只挂待停标记，而停用后补刀不可达，进程泄漏。
      if (p.supports('instanceLifecycle')) { for (const i of (p.instances || [])) { try { p.stopInstance(i, true); } catch {} } }
      if (events) events.append('router_provider_deactivated', { id, name: p.name });
      save();
    }
    return { ok: true, id, activated: false };
  }

  /** 守卫/路由器启动恢复：已激活供应商端点 + 反代实例常驻对账（幂等）。
   *  旧数据可能无 apiPort：补分配后持久化，此后重启复用。 */
  async function startActivatedProviders() {
    for (const p of state.providers || []) {
      if (p.activated !== true) continue;
      if (!p.apiPort) {
        try {
          p.apiPort = await ports.allocate('providerApi', 'providerApi:' + p.id);
          if (p.apiPort && !ports.isRegistered(p.apiPort)) ports.registerUser(p.apiPort, 'providerApi:' + p.id);
        } catch (e) { p.apiPort = null; }
        if (p.apiPort) save();
      }
      startProviderServer(p.id);
      if (p.supports('instanceLifecycle')) await scheduler.ensureProviderInstances(p).catch(() => {});
    }
  }

  return { handleForProvider, newServer, startProviderServer, stopProviderServer, activateProvider, deactivateProvider, startActivatedProviders };
}

module.exports = { createEndpoint, createAgents, newServer, readBody };
