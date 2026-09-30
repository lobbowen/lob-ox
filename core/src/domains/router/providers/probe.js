'use strict';

// 实例运行时探活与进程治理（IO 模块）：spawn、健康探活、生命周期监控、npm 包缓存、实例配额探测。
// 一律经 provider 显式入参，不持有实例/域状态。
// 进程载体（拉起/归属判定/终止）唯一走 platform/os/carrier（PROXY-ISOLATION-STANDARD L1）。

const path = require('node:path');
const fs = require('node:fs');
const ports = require('../../../platform/service/ports').shared;
const pidlook = require('../../../platform/os/pidlookup');
const carrier = require('../../../platform/os/carrier');
const procOS = require('../../../platform/os/process');
const { INSTANCE_STATES } = require('../model');
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
  // 防残留：同账号只保留一条 proxyInstance 端口记录（释放带 owner，防 TOCTOU 误删他人）
  if (inst.keyId) {
    const owner = 'proxy:' + inst.keyId;
    for (const rec of ports.list()) if (rec.owner === owner && rec.port !== inst.port) { try { ports.release(rec.port, rec.owner); } catch {} }
  }
  // 认领前置：绑定端口上的同 pkg 幸存进程一律 SIGKILL 弃用重拉（stdio 归属旧代，禁 adopt）
  if (!inst.pid && inst.port) {
    const boundPid = pidlook.findListeningPid(inst.port);
    if (boundPid) {
      const cmd = pidlook.readCmdline(boundPid) || '';
      const pkgMarker = (app && app.pkg) || '';
      if (pkgMarker && cmd.indexOf(pkgMarker) >= 0) {
        if (provider.logger && provider.logger.warn) provider.logger.warn('[proxy-instance] 重启幸存者弃用重拉 pid=' + boundPid + ' port=' + inst.port + '（stdio 归属旧代，禁 adopt）');
        if (provider.events) provider.events.append('proxy_instance_survivor_reclaimed', { app: provider.proxyAppId, port: inst.port, pid: boundPid, reason: 'restart-survivor-stdio-unsafe' });
        // 幸存者来路不明（旧代/手动）：外来 pid 一律不组信号，Windows 走 taskkill 整树。
        try { procOS.killTree(boundPid, 'SIGKILL'); } catch {}
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
  // 端口分配唯一入口 = claimSlot：byOwner 复用 -> preferred -> 段内最小空闲
  const owner = 'proxy:' + (inst.keyId || 'unknown');
  const slot = await ports.claimSlot('proxyInstance', owner, { preferred: inst.port || undefined });
  if (!slot || slot.conflict) return { ok: false, error: '反代端口段已满/冲突' };
  const port = slot.port;
  if (inst.port !== port) { inst.port = port; provider._persist(); }
  // 端口释放等待（EADDRINUSE 启停风暴根因）：旧进程 SIGTERM 后内核回收有延迟
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
  // 实例环境 = app 契约：账号密钥只经 env 传递、绝不进 cmdline（env 名由 app.keyEnv 声明）
  const keyEnv = (app && app.keyEnv) || 'CC_API_KEY';
  const envVars = Object.assign({}, process.env);
  envVars[keyEnv] = inst.key;
  if (app && app.env && typeof app.env === 'object') {
    for (const [k, v] of Object.entries(app.env)) {
      if (k === keyEnv) continue;
      envVars[k] = String(v).replace('{{key}}', inst.key).replace('{{port}}', String(port));
    }
  }
  // 契约 registry 走 registry-ref 单口注入：畸形基址写进 env 会让实例报出与真实原因无关的连接错误。
  const rpReg = registryRef.registryEnvPair(launch.registry);
  if (rpReg.ok) Object.assign(envVars, rpReg.env);
  else if (launch.registry && provider.logger) provider.logger.warn('[proxy-instance] 契约 registry 非法（' + rpReg.violation + '），改用 npx 默认源');
  // 实例 stdout/stderr 全量落盘 + 关键词行落事件（stateDir 由 Provider 注入）。
  // 落盘必须走 Rotator：首建即 0600（实例日志含启动令牌 URL/环境变量派生行），且超阈值轮转防无界增长。
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
  // 身份锚点（隔离标准 L2 的衍生物）：包名 + '--port' 须同时出现在载体进程与其
  //   子孙监听者的 cmdline，配合 run.pid 判归属——防 PID 复用误杀，三平台同语义。
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
  // Rotator 每次 write 即时 appendFileSync，无缓冲 => 关闭时不需（也无法）end()。
  inst.pid = child.pid;
  inst.port = port;
  inst.pidFile = pidFile;
  inst.launchAnchors = anchors;
  inst.status = INSTANCE_STATES.WARM;
  inst.healthy = false;
  // 关停竞态：stop() 先于 spawn 完成时一次也不漏，立即自清
  if (provider._stopping) {
    try { provider.stopInstance(inst); } catch {}
    return { ok: true, port, pid: child.pid, stoppedDuringShutdown: true };
  }
  // 只认领当前代：重启时旧进程晚退（close/error 在新 pid 写入之后才触发）不得清掉新实例的登记。
  child.on('close', (code) => {
    if (inst.pid === child.pid) {
      inst.pid = null; inst.healthy = false;
      inst.status = INSTANCE_STATES.COLD; // 端口与实例绑死：不清 port、不释放 registry 登记
    }
    if (provider.events) provider.events.append('proxy_instance_stopped', { app: provider.proxyAppId, port, code });
  });
  child.on('error', (err) => {
    // error = 进程从未成功存活（ENOENT 等 spawn 失败派生）：pid 已无，态必须回 COLD
    //   （DEAD 的定义是「进程在但不健康」，见 model.js）。
    if (inst.pid === child.pid) { inst.pid = null; inst.healthy = false; inst.status = INSTANCE_STATES.COLD; }
    if (provider.events) provider.events.append('proxy_instance_failed', { app: provider.proxyAppId, port, error: err.message });
  });
  provider._persist();
  if (provider.events) provider.events.append('proxy_instance_started', { app: provider.proxyAppId, port, pid: child.pid });
  return { ok: true, port, pid: child.pid };
}

/** 实例探活：纯 HTTP 探测并回报 inst.healthy；本函数不持有任何失败计数。 */
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

/** 实例生命周期监控：进程存活 + 端口归属 + HTTP 卡死检测（连续失败 kill 重拉）。 */
async function monitorLifecycle(provider) {
  if (provider._stopping || provider.activated !== true) return;
  for (const inst of (provider.instances || [])) {
    if (!inst || !inst.pid || !inst.port) continue;
    // DEAD 只是「进程在但不健康」：不得在此跳过，否则 HTTP 探活与 _monitorFails 无法跨轮累积，
    // 连续 3 次 kill 重拉的分支恒不可达。
    let alive = false;
    try { alive = pidlook.isAlive ? pidlook.isAlive(inst.pid) : true; } catch {}
    if (!alive) {
      if (provider.logger && provider.logger.warn) provider.logger.warn('[proxy-instance] 生命周期监控：进程死亡 key=' + inst.maskedKey + ' pid=' + inst.pid);
      inst.pid = null; inst.healthy = false; inst._monitorFails = 0; inst.status = INSTANCE_STATES.COLD;
      continue;
    }
    // 端口占住判定走载体身份引擎（标准 L1）：锚点命中才算我方进程；监听者查不到
    //   （探测工具缺失）不改判，交给下方 HTTP 探活（连续 3 次不健康即 kill 重拉），避免误杀。
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
          // 卡死重拉：本方 detached 拉起的组长 pid，POSIX 组信号整树、win taskkill /T /F。
          try { procOS.killTree(inst.pid, 'SIGKILL', undefined, { ownGroup: true }); } catch {}
          inst.pid = null; inst.healthy = false; inst._monitorFails = 0; inst.status = INSTANCE_STATES.COLD;
        }
      }
    }
  }
}

/** 模式级配额检测：按 app.quota.type 查策略注册表执行取数与解析。 */
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

/** 响应驱动冻结后的异步补探测：真实超限 -> quota 刷新；误判 -> 自动解冻。 */
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

/** 等待全部 SIGTERM 在途子进程真正退出（优雅退出专用，防停服遗留孤儿进程）。 */
async function waitAllStopped(provider, timeoutMs) {
  const dl = Date.now() + (timeoutMs || 3000);
  const sweep = () => {
    if (!provider._terminatingPids || !provider._terminatingPids.size) return;
    for (const pid of [...provider._terminatingPids]) {
      let alive = true;
      try { alive = pidlook.isAlive ? pidlook.isAlive(pid) : true; } catch { alive = false; }
      // zombie（SIGKILL 已投递、父进程未回收）kill(0) 仍为 true，但端口/stdio 已释放；判定经 pidlookup 门面。
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
      // 关停兜底升级：台账内 pid 全是本方 detached 拉起的组长（ownGroup:true 前提成立），killTree 三平台整树终止。
      try { procOS.killTree(pid, 'SIGKILL', undefined, { ownGroup: true }); } catch { /* 已退出 */ }
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
