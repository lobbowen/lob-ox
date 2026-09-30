'use strict';

// 供应商注册表（CRUD）+ 服务生命周期 + 端口释放；并持有域状态容器（createState）。
// 副作用经注入的 endpoint/scheduler/ports 执行，本文件不 require 实现。

/** 域内唯一可变状态的家（纯内存）。 */
function createState(opts) {
  const o = opts || {};
  return {
    providers: [],
    running: false,
    stopped: false,
    ring: [],
    ringMax: 800,
    proxyUpdateCache: {},
    modelPriceIndex: null,
    providerServers: {},
    maintTimer: null,
    pricingTimer: null,
    lifecycleTimer: null,
    agentHttp: o.agentHttp || null,
    agentHttps: o.agentHttps || null,
    probeRunning: false,
    refreshRunning: false,
    lastProbeAt: 0,
    lastRefreshAt: 0,
    log(line) {
      this.ring.push(line);
      if (this.ring.length > this.ringMax) this.ring.splice(0, this.ring.length - this.ringMax);
    },
  };
}

function findProvider(providers, id) { return (providers || []).find((p) => p.id === id) || null; }

/** 释放某供应商在端口注册表中的全部记录（providerApi:<id> 与各 proxy:<keyId>）。 */
function releaseProviderPorts(p, ports) {
  if (!p || !ports) return;
  try { ports.unregister('providerApi:' + p.id); } catch {}
  for (const i of (p.instances || [])) {
    if (i && i.keyId) { try { ports.unregister('proxy:' + i.keyId); } catch {} }
  }
}

function createOps(deps) {
  const d = deps || {};
  const state = d.state;
  const logger = d.logger || console;
  const events = d.events || null;
  const ports = d.ports;
  const endpoint = d.endpoint;
  const scheduler = d.scheduler;
  const createDirect = d.createDirect;
  const createProxy = d.createProxy;
  const apps = d.apps || {};
  const presets = d.presets || [];
  const save = d.save || (() => {});

  function addDirectProvider(opts) {
    const preset = (opts && opts.presetId) ? (presets.find((x) => x.id === opts.presetId) || null) : null;
    const baseUrl = (opts && opts.baseUrl) || (preset ? preset.baseUrl : '') || '';
    let existing = state.providers.find((p) => p.kind === 'direct' && p.baseUrl === baseUrl);
    if (!existing && preset) existing = state.providers.find((p) => p.kind === 'direct' && p.presetId === preset.id);
    if (existing) {
      for (const k of (opts && opts.keys) || []) { const t = String(k).trim(); if (t && !existing.accounts.some((a) => a.key === t)) existing.addAccount(t).then(() => save()).catch(() => {}); }
      save();
      return { ok: true, id: existing.id, already: true };
    }
    const p = createDirect({ id: 'prov-' + Date.now() + '-' + Math.floor(Math.random() * 1000), name: (opts && opts.name) || (preset ? preset.name : '供应商'), kind: 'direct', baseUrl, plan: preset ? { ...preset.plan } : null, pricing: preset ? { ...preset.pricing } : {}, adapter: preset ? preset.adapter : null, presetId: preset ? preset.id : null, logger, events, dist: d.dist, onPersist: save });
    state.providers.push(p);
    for (const k of (opts && opts.keys) || []) { const t = String(k).trim(); if (t && !p.accounts.some((a) => a.key === t)) p.addAccount(t).then(() => save()).catch(() => {}); }
    save();
    return { ok: true, id: p.id };
  }

  function addProxyProvider(opts) {
    const app = apps[opts && opts.appId];
    if (!app) return { ok: false, error: '未知反代应用 ' + (opts && opts.appId) };
    let p = state.providers.find((x) => x.kind === 'proxy' && x.proxyAppId === app.id);
    let created = false;
    if (!p) {
      p = createProxy({ id: 'prov-' + Date.now() + '-' + Math.floor(Math.random() * 1000), name: (opts && opts.name) || app.name, kind: 'proxy', proxyAppId: app.id, app, logger, events, dist: d.dist, onPersist: save });
      p.proxyRunning = true;
      state.providers.push(p);
      created = true;
    }
    for (const k of (opts && opts.keys) || []) { const t = String(k).trim(); if (t && !p.accounts.some((a) => a.key === t)) p.addAccount(t).then(() => save()).catch(() => {}); }
    save();
    return { ok: true, id: p.id, created, added: (opts && opts.keys) ? opts.keys.length : 0 };
  }

  function removeProvider(id) {
    const idx = state.providers.findIndex((p) => p.id === id);
    if (idx < 0) return { ok: false, error: '供应商不存在' };
    const removed = state.providers.splice(idx, 1)[0];
    endpoint.stopProviderServer(id); // 删除即停用：关闭其独立端点
    // 删除路径必须 force 停实例：不带 force 时，账号被 selected/activeAccount 指向则只置
    // _stopPendingUntilIdle 就返回；provider 摘除后该标记不可达、补刀无从触发，
    // 持用户 API Key 的反代进程永不被回收。
    if (removed.supports('instanceLifecycle')) { for (const i of removed.instances || []) { try { removed.stopInstance(i, true); } catch {} } }
    // 端口登记级联释放（「删除对象即释放端口」契约）：否则 owner 永久累积、池最终耗尽。
    try { releaseProviderPorts(removed, ports); } catch (e) { if (logger && logger.warn) logger.warn('release provider ports ' + id + ': ' + (e && e.message)); }
    save();
    return { ok: true };
  }

  function start() {
    if (state.running) return Promise.resolve({ ok: true, already: true });
    state.running = true;
    state.stopped = false;
    for (const p of state.providers) { if (p && p.supports('processPool')) p._stopping = false; }
    scheduler.start();
    return endpoint.startActivatedProviders().then(() => {
      if (events) events.append('router_started', { providers: state.providers.length });
      return { ok: true };
    }).catch((e) => ({ ok: false, error: e.message }));
  }

  function stopAll() {
    state.running = false;
    state.stopped = true; // 先置闸：在途/后续的 ensure/预热/探测不得再拉起实例
    for (const p of state.providers) { if (p && p.supports('processPool')) p._stopping = true; } // 预启动拒绝 + spawn 完成即自清
    scheduler.stop();
    stopAllInstances(); // 服务停止 = 实例一并停止（防孤儿进程残留占用动态端口段）
    for (const id of Object.keys(state.providerServers)) endpoint.stopProviderServer(id); // 供应商独立端点一并关闭
    // 用量账本改节流落盘后，停服前强制 flush，未到点的账不丢。
    try { if (d.usage && typeof d.usage.flush === 'function') d.usage.flush(); } catch (e) { logger.warn && logger.warn('usage flush: ' + ((e && e.message) || e)); }
    if (events) events.append('router_stopped', {});
    return { ok: true };
  }

  function stop() { return stopAll(); }

  /** 优雅退出：停实例并【确认子进程已死】再返回（daemon shutdown 专用）。 */
  async function stopAndWait(timeoutMs) {
    stopAll();
    for (const p of state.providers) {
      if (p && p.supports('gracefulStop')) {
        try { await p.waitAllStopped(timeoutMs || 3000); } catch {}
      }
    }
    return { ok: true };
  }

  /** 停止全部反代实例进程（测试收尾 / 守卫优雅退出用）。 */
  function stopAllInstances() {
    // force=true：服务停服/优雅退出，无视在用/在途仲裁强制停。
    for (const p of state.providers) {
      if (!p.supports('instanceLifecycle')) continue;
      for (const i of (p.instances || [])) { try { p.stopInstance(i, true); } catch {} }
    }
  }

  return { addDirectProvider, addProxyProvider, removeProvider, start, stop, stopAndWait, stopAllInstances };
}

module.exports = { createState, createOps, findProvider };
