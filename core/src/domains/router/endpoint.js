'use strict';

const https = require('node:https');

const http = require('node:http');
const { readBody } = require('./handlers/parse');

function createAgents() {
  return {
    http: new http.Agent({ keepAlive: true, keepAliveMsecs: 30000, maxSockets: 128 }),
    https: new https.Agent({ keepAlive: true, keepAliveMsecs: 30000, maxSockets: 128 }),
  };
}

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
    state.providerServers[id] = server;
    server.on('error', (err) => {
      log('provider endpoint ' + p.name + ' error: ' + err.message);
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

  async function activateProvider(id) {
    const p = getProvider(id);
    if (!p) return { ok: false, error: '供应商不存在' };
    if (!p.activated) {
      p.activated = true;
      if (!p.apiPort) {
        try { p.apiPort = await ports.allocate('providerApi', 'providerApi:' + id); } catch (e) { p.apiPort = null; }
        if (p.apiPort) { try { if (!ports.isRegistered(p.apiPort)) ports.registerUser(p.apiPort, 'providerApi:' + id); } catch {} }
      }
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

  function deactivateProvider(id) {
    const p = getProvider(id);
    if (!p) return { ok: false, error: '供应商不存在' };
    if (p.activated) {
      p.activated = false;
      stopProviderServer(id);
      if (p.supports('instanceLifecycle')) { for (const i of (p.instances || [])) { try { p.stopInstance(i, true); } catch {} } }
      if (events) events.append('router_provider_deactivated', { id, name: p.name });
      save();
    }
    return { ok: true, id, activated: false };
  }

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
