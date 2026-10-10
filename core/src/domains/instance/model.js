'use strict';

const { semverCompare } = require('../../shared/version');

const { taskStateToView } = require('../../shared/task-state');

function normalizeInstance(inst) {
  if (Object.prototype.hasOwnProperty.call(inst, 'dshToken')) delete inst.dshToken;
  if (inst.remoteMode !== 'lan' && inst.remoteMode !== 'wan') {
    inst.remoteMode = inst.remoteEnabled === true ? (inst.frpEnabled === true ? 'wan' : 'lan') : 'off';
  }
  delete inst.remoteEnabled;
  delete inst.frpEnabled;
  delete inst.frpRemotePort;
  delete inst.wanPort;
  if (inst.sandbox) { delete inst.sandbox.memoryMax; delete inst.sandbox.cpuQuota; }
  if (inst.guardian === undefined) inst.guardian = false;
  if (inst.state) {
    
    
    
    
    if (inst.state.phase === 'BACKOFF') inst.state.phase = 'FAILED';
    delete inst.state.backoffLevel;
    delete inst.state.backoffUntil;
    if (!Number.isInteger(inst.state.startupFailCount) || inst.state.startupFailCount < 0) inst.state.startupFailCount = 0;
    if (!(inst.state.startupFailWindowStart === null || typeof inst.state.startupFailWindowStart === 'number')) {
      inst.state.startupFailWindowStart = null;
    }
    if (!(inst.state.restartAt === null || typeof inst.state.restartAt === 'number')) inst.state.restartAt = null;
    if (!(inst.state.restartCount === null || typeof inst.state.restartCount === 'number')) inst.state.restartCount = 0;
    inst.state.phase = inst.state.phase || 'STOPPED';
    delete inst.state.desired;
  }
  return inst;
}

function createRecord(payload, id) {
  const port = parseInt(payload.port, 10);
  return {
    id,
    name: String(payload.name || ('实例:' + port)).slice(0, 40),
    port,
    domain: 'sandbox',
    kind: 'sandbox',
    autoRegistered: false,
    createdBy: 'user',
    command: Array.isArray(payload.command) ? payload.command : [],
    guardian: !!payload.guardian,
    remoteMode: payload.remoteMode === 'lan' || payload.remoteMode === 'wan' ? payload.remoteMode : 'off',
    remoteToken: String(payload.remoteToken || ''),
    unitName: 'dsh-web@' + id,
    sandbox: {
      privateTmp: true,
      protectHome: payload.protectHome === undefined ? false : !!payload.protectHome,
    },
    state: { phase: 'STOPPED', restartCount: 0, startupFailWindowStart: null, startupFailCount: 0, restartAt: null, startAt: null, lastFailAt: null },
    createdAt: new Date().toISOString(),
  };
}

function viewRow(inst, resolved) {
  const version = resolved.version;
  const latest = resolved.latest;
  return {
    id: inst.id,
    name: inst.name,
    port: inst.port,
    domain: inst.domain || 'native',
    kind: inst.kind || inst.domain || 'native',
    guardian: inst.guardian,
    remoteMode: inst.remoteMode || 'off',
    unitName: inst.unitName,
    sandbox: inst.sandbox,
    version,
    latest,
    updateAvailable: !!(latest && version && semverCompare(latest, version) > 0),
    updateJob: resolved.updateJob,
    state: Object.assign({}, resolved.probe, {
      lifecyclePhase: inst.state ? inst.state.phase : 'STOPPED',
      lastError: inst.state ? inst.state.lastError : null,
      allocation: inst.state ? (inst.state.allocation || null) : null,
      usage: inst.state ? (inst.state.usage || null) : null,
      restartCount: inst.state ? (inst.state.restartCount || 0) : 0,
      
      startupFailCount: inst.state ? (inst.state.startupFailCount || 0) : 0,
      restartAt: inst.state ? (inst.state.restartAt || null) : null,
      lastFailure: inst.state ? (inst.state.lastFailure || null) : null,
      installing: inst.state && inst.state.phase === 'INSTALLING',
      installOk: inst.state ? inst.state.installOk : undefined,
      installError: inst.state ? inst.state.installError : undefined,
      installLog: inst.state ? (inst.state.installLog || []) : [],
    }),
  };
}

module.exports = { taskStateToView, normalizeInstance, createRecord, viewRow };
