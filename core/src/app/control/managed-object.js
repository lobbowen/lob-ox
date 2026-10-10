'use strict';

const DESIRED = ['running', 'stopped'];

const MANAGED_KINDS = {
  dsh:              { label: '原生 DSH',       startable: true, guardable: true },
  'sandbox-instance': { label: '沙箱实例',     startable: true, guardable: true },
  'router-daemon':  { label: '智能路由 daemon', startable: true, guardable: true },
  'lan-daemon':     { label: '远程控制 daemon', startable: true, guardable: true },
  plugin:           { label: '插件（聚合）',    startable: false, guardable: false },
  shell:            { label: '桌面壳',          startable: false, guardable: false },
};

let _customKinds = {};

function kindMeta(kind) {
  return MANAGED_KINDS[kind] || _customKinds[kind] || null;
}

function registerKind(kind, meta) {
  _customKinds[kind] = Object.assign({ label: kind, startable: false, guardable: false }, meta || {});
}

function createEntry(o) {
  const meta = kindMeta(o.kind);
  if (!meta) throw new Error('未知受管对象类型: ' + o.kind + '（先 registerKind 声明）');
  if (!o.id || typeof o.id !== 'string') throw new Error('注册项缺少 id');
  return {
    kind: o.kind,
    id: o.id,
    name: String(o.name || o.id),
    desired: (o.desired === 'stopped') ? 'stopped' : 'running',
    ownership: normalizeOwnership(o.ownership),
    phase: 'stopped',
    lastObserved: null,
    process: null,
    domainSummary: null,
    startupFailWindowStart: null,
    startupFailCount: 0,
    restartCount: 0,
    startedAt: null,
    lastTransitionAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function normalizeOwnership(own) {
  const o = own || {};
  const ports = Array.isArray(o.ports) ? o.ports
    .filter((p) => p && Number.isInteger(Number(p.port)) && p.port > 0)
    .map((p) => ({ role: String(p.role || 'default'), port: Number(p.port) })) : [];
  return {
    ports,
    rootPath: o.rootPath ? String(o.rootPath) : null,
    unit: o.unit ? String(o.unit) : null,
    daemonScript: o.daemonScript ? String(o.daemonScript) : null,
    processMode: ['spawn', 'systemd', 'daemon', 'adopted'].includes(o.processMode) ? o.processMode : null,
    meta: (o.meta && typeof o.meta === 'object') ? Object.assign({}, o.meta) : null,
  };
}

module.exports = { DESIRED, MANAGED_KINDS, kindMeta, registerKind, createEntry, normalizeOwnership };
