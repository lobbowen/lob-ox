'use strict';

const probe = require('../../platform/util/probe');

const ports = require('../../platform/service/ports').shared;
const SIBLING_REGISTRIES = ['ports-router.json'];

const DEPS = new WeakMap();
function depsOf(host) {
  let d = DEPS.get(host);
  if (!d) {
    d = {
      logger() { return host.logger; },
      portActives(list) { return host._portActives(list); },
      readPortActivesCache() { return host._portActivesCache; },
      writePortActivesCache(v) { host._portActivesCache = v; },
    };
    DEPS.set(host, d);
  }
  return d;
}

module.exports = { methods: {

  async listPorts() {
    const d = depsOf(this);
    try { ports.reload(); } catch (e) { d.logger() && d.logger().warn && d.logger().warn('ports reload: ' + (e && e.message)); }
    const byPort = new Map();
    const adopt = (rec) => {
      if (!rec || !Number.isInteger(rec.port) || !rec.role || byPort.has(rec.port)) return;
      byPort.set(rec.port, {
        port: rec.port, role: rec.role, owner: rec.owner || null,
        createdAt: Number.isInteger(rec.createdAt) ? rec.createdAt : Date.now(),
      });
    };
    for (const r of ports.readAll(SIBLING_REGISTRIES)) adopt(r);
    const merged = [...byPort.values()].filter((r) => r.role !== "oauthCallback");
    const activeByPort = await d.portActives(merged.map((r) => r.port));
    const records = merged.map((r) => ({
      port: r.port, role: r.role, owner: r.owner, createdAt: r.createdAt,
      active: !!(activeByPort && activeByPort[r.port]) || false,
    }));
    const snap = ports.snapshotAll();
    const apiAct = records.filter((r) => r.role === "supervisor-api" && r.active);
    const out = apiAct.length ? records.filter((r) => r.role !== "supervisor-api" || r.active) : records;
    let capacity = null;
    try { capacity = (typeof ports.capacity === 'function') ? ports.capacity() : null; } catch {}
    return { records: out, snapshot: snap, capacity };
  },

  async _portActives(portsList) {
    const d = depsOf(this);
    const now = Date.now();
    const key = portsList.join(',');
    const cache = d.readPortActivesCache();
    if (cache && cache.key === key && now - cache.at < 3000) {
      return cache.map;
    }
    const results = await Promise.all((portsList || []).map((port) => probe.portListening('127.0.0.1', Number(port), 300)));
    const map = {};
    for (let i = 0; i < portsList.length; i++) map[portsList[i]] = !!results[i];
    d.writePortActivesCache({ key, at: now, map });
    return map;
  },
} };
