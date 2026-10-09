'use strict';

const path = require('node:path');
const fs = require('node:fs');
const ports = require('../../../platform/service/ports').shared;
const pidlook = require('../../../platform/os/pidlookup');
const carrier = require('../../../platform/os/carrier');
const procOS = require('../../../platform/os/process');
const { INSTANCE_STATES } = require('../model');
const { ProcessLifecycle } = require('../../../app/control/process-lifecycle');
const { getQuotaStrategy } = require('./quota-strategies');
const { quotaOverallStatus } = require('./policies/quota');
const { cachedPkgBin, ensurePkgCached } = require('./pkg-cache');
const stateRoot = require('../../../platform/service/state-root');
const { Rotator } = require('../../../platform/service/log/log');
const registryRef = require('../../../platform/distribution/registry-ref');
const INSTANCE_LOG_MAX_BYTES = 2 * 1024 * 1024;

async function spawnInstance(provider, inst) {
  const app = provider.app;
  if (!app) return { ok: false, error: '未知反代应用' };
  if (inst.keyId) {
    const owner = 'proxy:' + inst.keyId;
    for (const rec of ports.list()) if (rec.owner === owner && rec.port !== inst.port) { try { ports.release(rec.port, rec.owner); } catch {} }
  }
  if (!inst.pid && inst.port) {
    const boundPid = pidlook.findListeningPid(inst.port);
    if (boundPid) {
      const cmd = pidlook.readCmdline(boundPid) || '';
      const pkgMarker = (app && app.pkg) || '';
      if (pkgMarker && cmd.indexOf(pkgMarker) >= 0) {
        if (provider.logger && provider.logger.warn) provider.logger.warn('[proxy-instance] 重启幸存者弃用重拉 pid=' + boundPid + ' port=' + inst.port + '（stdio 归属旧代，禁 adopt）');
        if (provider.events) provider.events.append('proxy_instance_survivor_reclaimed', { app: provider.proxyAppId, port: inst.port, pid: boundPid, reason: 'restart-survivor-stdio-unsafe' });
        // 统一停进程原语（S3）：收敛到 ProcessLifecycle，不再内联 killTree。
        try { ProcessLifecycle.stopProcess({ pid: boundPid, port: inst.port }); } catch {}
        const dl = Date.now() + 3000;
        while (Date.now() < dl && (await ports.isTaken(inst.port, 'proxy:' + (inst.keyId || 'unknown')).catch(() => false))) {
          await new Promise((r) => setTimeout(r, 150));
        }
        inst.pid = null;
        inst.status = INSTANCE_STATES.COLD;
        inst.healthy = false;
        inst._unhealthyCount = 0;
        provider._persist();
      }
    }
  }
  const owner = 'proxy:' + (inst.keyId || 'unknown');
  const slot = await ports.claimSlot('proxyInstance', owner, { preferred: inst.port || undefined });
  if (!slot || slot.conflict) return { ok: false, error: '反代端口段已满/冲突' };
  const port = slot.port;
  if (inst.port !== port) { inst.port = port; provider._persist(); }
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && (await ports.isTaken(port, owner).catch(() => false))) {
    await new Promise((r) => setTimeout(r, 200));
  }
  if (await ports.isTaken(port, owner).catch(() => false)) {
    const msg = '端口 ' + port + ' 仍被占用（非本账号健康进程未退出），本次启动放弃';
    if (provider.events) provider.events.append('proxy_instance_start_port_busy', { app: provider.proxyAppId, port });
    if (provider.logger && provider.logger.warn) provider.logger.warn('[proxy-instance] ' + msg);
    inst.status = INSTANCE_STATES.COLD; inst.healthy = false; provider._persist();
    return { ok: false, error: msg };
  }
  const launch = await provider._resolveLaunchCommand(app, port, inst.key);
  if (!launch.ok) return launch;
  const keyEnv = (app && app.keyEnv) || 'CC_API_KEY';
  const envVars = Object.assign({}, process.env);
  envVars[keyEnv] = inst.key;
  if (app && app.env && typeof app.env === 'object') {
    for (const [k, v] of Object.entries(app.env)) {
      if (k === keyEnv) continue;
      envVars[k] = String(v).replace('{{key}}', inst.key).replace('{{port}}', String(port));
    }
  }
  const rpReg = registryRef.registryEnvPair(launch.registry);
  if (rpReg.ok) Object.assign(envVars, rpReg.env);
  else if (launch.registry && provider.logger) provider.logger.warn('[proxy-instance] 契约 registry 非法（' + rpReg.violation + '），改用 npx 默认源');
  const logFilter = /error|streaming|idle|timeout|ECONN|abort|socket|finish|truncat/i;
  const baseDir = provider.stateDir || stateRoot.supervisorDir();
  let logWriter = null;
  try {
    const logDir = path.join(baseDir, 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    logWriter = new Rotator(path.join(logDir, 'proxy-instance-' + provider.proxyAppId + '-' + port + '.log'), INSTANCE_LOG_MAX_BYTES);
  } catch {}
  const pushLog = (buf, src) => {
    if (logWriter) { try { logWriter.write('[' + new Date().toISOString() + '][' + src + '] ' + String(buf).replace(/[\r\n]+$/, '')); } catch {} }
    for (const raw of String(buf).split(/\r?\n/)) {
      const l = raw.trim();
      if (!l || !logFilter.test(l)) continue;
      if (provider.events) provider.events.append('proxy_instance_log', { app: provider.proxyAppId, port, src, line: l.slice(0, 400) });
      if (provider.logger && provider.logger.warn) provider.logger.warn('[proxy-instance] ' + src + ': ' + l.slice(0, 400));
    }
  };
  const anchors = [];
  if (app.pkg) anchors.push(String(app.pkg));
  anchors.push('--port ' + port);
  let pidFile = null;
  try { fs.mkdirSync(path.join(baseDir, 'run'), { recursive: true }); pidFile = path.join(baseDir, 'run', 'proxy-' + provider.proxyAppId + '-' + port + '.pid'); } catch {}
  let handle;
  try {
    handle = carrier.start({
      cmd: launch.cmd,
      env: envVars,
      identity: { port, pidFile, anchors },
      onOutput: (c) => { c.stdout.on('data', (b) => pushLog(b, 'out')); c.stderr.on('data', (b) => pushLog(b, 'err')); },
    });
  }
  catch (e) { return { ok: false, error: 'spawn 失败: ' + e.message }; }
  const child = handle.child;
  inst.pid = child.pid;
  inst.port = port;
  inst.pidFile = pidFile;
  inst.launchAnchors = anchors;
  inst.status = INSTANCE_STATES.WARM;
  inst.healthy = false;
  if (provider._stopping) {
    try { provider.stopInstance(inst); } catch {}
    return { ok: true, port, pid: child.pid, stoppedDuringShutdown: true };
  }
  child.on('close', (code) => {
    if (inst.pid === child.pid) {
      inst.pid = null; inst.healthy = false;
      inst.status = INSTANCE_STATES.COLD;
    }
    if (provider.events) provider.events.append('proxy_instance_stopped', { app: provider.proxyAppId, port, code });
  });
  child.on('error', (err) => {
    // spawn 失败（ENOENT）派生：pid 已无，态必须回 COLD（DEAD 的定义是「进程在但不健康」）。
    if (inst.pid === child.pid) { inst.pid = null; inst.healthy = false; inst.status = INSTANCE_STATES.COLD; }
    if (provider.events) provider.events.append('proxy_instance_failed', { app: provider.proxyAppId, port, error: err.message });
  });
  provider._persist();
  if (provider.events) provider.events.append('proxy_instance_started', { app: provider.proxyAppId, port, pid: child.pid });
  return { ok: true, port, pid: child.pid };
}

async function healthInstance(provider, inst) {
  if (!inst || !inst.port) return;
  const app = provider.app;
  if (!app) return;
  try {
    const res = await fetch('http://127.0.0.1:' + inst.port + app.healthPath, { signal: AbortSignal.timeout(3000) });
    inst.healthy = res.ok;
    if (res.ok) {
      inst.status = INSTANCE_STATES.HOT;
      try { const j = await res.json(); if (j.version) inst.version = j.version; } catch {}
    } else {
      inst.status = INSTANCE_STATES.DEAD;
    }
  } catch {
    inst.healthy = false;
    inst.status = INSTANCE_STATES.DEAD;
  }
}

async function monitorLifecycle(provider) {
  if (provider._stopping || provider.activated !== true) return;
  for (const inst of (provider.instances || [])) {
    if (!inst || !inst.pid || !inst.port) continue;
    let alive = false;
    try { alive = pidlook.isAlive ? pidlook.isAlive(inst.pid) : true; } catch {}
    if (!alive) {
      if (provider.logger && provider.logger.warn) provider.logger.warn('[proxy-instance] 生命周期监控：进程死亡 key=' + inst.maskedKey + ' pid=' + inst.pid);
      inst.pid = null; inst.healthy = false; inst._monitorFails = 0; inst.status = INSTANCE_STATES.COLD;
      continue;
    }
    if (inst.pidFile && inst.launchAnchors && inst.launchAnchors.length) {
      const st = carrier.probe({ port: inst.port, pidFile: inst.pidFile, anchors: inst.launchAnchors });
      if (st.state === 'foreign') {
        if (provider.logger && provider.logger.warn) provider.logger.warn('[proxy-instance] 生命周期监控：端口被外部进程占住 key=' + inst.maskedKey + ' port=' + inst.port + ' pid=' + inst.pid + ' listener=' + st.pid);
        inst.pid = null; inst.healthy = false; inst._monitorFails = 0; inst.status = INSTANCE_STATES.COLD;
        continue;
      }
    }
    if (provider.app && provider.app.healthPath) {
      await healthInstance(provider, inst);
      if (inst.healthy) {
        inst._monitorFails = 0;
      } else {
        inst._monitorFails = (inst._monitorFails || 0) + 1;
        if (inst._monitorFails >= 3) {
          if (provider.logger && provider.logger.warn) provider.logger.warn('[proxy-instance] 生命周期监控：实例无响应（疑似卡死）key=' + inst.maskedKey + ' port=' + inst.port + ' pid=' + inst.pid + ' fails=' + inst._monitorFails + '，kill 重拉');
          if (provider.events) provider.events.append('proxy_instance_hang_restart', { app: provider.proxyAppId, port: inst.port, pid: inst.pid, fails: inst._monitorFails });
          try { ProcessLifecycle.stopProcess({ pid: inst.pid, port: inst.port }); } catch {}
          inst.pid = null; inst.healthy = false; inst._monitorFails = 0; inst.status = INSTANCE_STATES.COLD;
        }
      }
    }
  }
}

async function detectInstanceQuota(provider, inst) {
  const app = provider.app;
  if (!app || !app.quota) { inst.quota = null; return { ok: true, quota: null }; }
  const q = app.quota;
  let strategy = getQuotaStrategy(q.type);
  if (!strategy && q.usagePath) strategy = getQuotaStrategy('window-usage');
  if (!strategy) { inst.quota = null; return { ok: true, quota: null }; }
  try {
    let det;
    if (strategy.kind === 'official-billing') {
      const acc = provider.accountOf(inst);
      const creditFrozen = !!(acc && acc.limit && acc.limit.kind === 'credits');
      det = await strategy.detect({ key: inst.key, quota: q, cache: inst, prevQuota: inst.quota, creditFrozen }).catch((e) => ({ ok: false, error: e.message }));
    } else {
      if (!q.usagePath) { inst.quota = null; return { ok: true, quota: null }; }
      det = await strategy.detect({ url: 'http://127.0.0.1:' + inst.port + q.usagePath, key: null, timeout: 3000, roundPercent: true }).catch((e) => ({ ok: false, error: e.message }));
    }
    if (!det.ok || !det.quota) { inst.quota = null; return { ok: false, error: (det && det.error) || '无法获取配额' }; }
    inst.quota = det.quota;
    inst.quota.overallStatus = quotaOverallStatus(inst.quota);
    return { ok: true, quota: inst.quota };
  } catch (e) { inst.quota = null; return { ok: false, error: e.message }; }
}

function probeAfterResponseFreeze(provider, acc) {
  if (!acc || acc.status === 'banned' || acc.status === 'discarded') return;
  const app = provider.app;
  if (!app || !app.quota || !app.quota.type) return;
  const strategy = getQuotaStrategy(app.quota.type);
  if (!strategy || strategy.kind !== 'official-billing') return;
  const inst = provider.instanceOf(acc);
  if (!inst) return;
  setTimeout(async () => {
    try {
      if (provider._stopping) return;
      const det = await detectInstanceQuota(provider, inst);
      if (!det.ok || !det.quota) return;
      inst.quota = det.quota;
      acc.quota = det.quota;
      acc.quota.overallStatus = quotaOverallStatus(acc.quota);
      provider.applyDetection(acc, { ok: true, quota: det.quota });
      provider._persist && provider._persist();
    } catch (e) {
      if (provider.logger && provider.logger.debug) provider.logger.debug('[proxy] 冻结后补探测失败: ' + ((e && e.message) || e));
    }
  }, 300);
}

async function waitAllStopped(provider, timeoutMs) {
  const dl = Date.now() + (timeoutMs || 3000);
  const sweep = () => {
    if (!provider._terminatingPids || !provider._terminatingPids.size) return;
    for (const pid of [...provider._terminatingPids]) {
      let alive = true;
      try { alive = pidlook.isAlive ? pidlook.isAlive(pid) : true; } catch { alive = false; }
      if (!alive || pidlook.isZombie(pid)) provider._terminatingPids.delete(pid);
    }
  };
  while (Date.now() < dl && provider._terminatingPids.size) {
    sweep();
    if (!provider._terminatingPids.size) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  if (provider._terminatingPids.size) {
    for (const pid of [...provider._terminatingPids]) {
      try { procOS.killTree(pid, 'SIGKILL', undefined, { ownGroup: true }); } catch {  }
    }
    const dl2 = Date.now() + 2000;
    while (Date.now() < dl2 && provider._terminatingPids.size) {
      sweep();
      if (!provider._terminatingPids.size) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    if (provider._terminatingPids && provider._terminatingPids.size) provider._terminatingPids.clear();
  }
  return true;
}

module.exports = { cachedPkgBin, ensurePkgCached, spawnInstance, healthInstance, monitorLifecycle, detectInstanceQuota, probeAfterResponseFreeze, waitAllStopped };
