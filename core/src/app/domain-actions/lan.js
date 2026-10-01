'use strict';

const { validateWanAccess, generateRemoteToken } = require('../../domains/relay/core');
const { remoteTokenStrength } = require('../../shared/credential');
const BRAND = require('../../shared/brand');

function lanModule(deps) {
  const lm = typeof deps.getLifecycleManager === 'function' ? deps.getLifecycleManager() : null;
  const hostLan = typeof deps.getLan === 'function' ? deps.getLan() : null;
  if (lm && typeof lm.get === 'function') {
    const lc = lm.get('lan');
    if (!lc) return null;
    if (!lc.module && hostLan) lc.module = hostLan;
    return lc.module || null;
  }
  return hostLan || null;
}

function createLanActions(deps) {
  const g = deps || {};

  function resolveTarget(id) {
    if (id === 'main') {
      const meta = g.getState().readMainMeta();
      return { kind: 'main', mode: meta.remoteMode, remoteToken: meta.remoteToken || '' };
    }
    const insts = g.getInstances();
    const rec = insts && typeof insts.all === 'function' ? insts.all().find((i) => i.id === id) : null;
    return rec ? { kind: 'sandbox', mode: rec.remoteMode, remoteToken: rec.remoteToken || '' } : null;
  }

  function applyMainIntent(patch, modeEventPayload) {
    const state = g.getState();
    state.writeMainMeta(patch);
    const daemons = g.getDaemons();
    if (daemons.enabled()) { try { daemons.syncLanState(); } catch {} }
    else {
      const lan = lanModule(g);
      if (lan && typeof lan.syncProxy === 'function') {
        lan.syncProxy(g.getViews().dshMain()).catch((e) => {
          const logger = g.getLogger(); logger && logger.warn && logger.warn('lan syncProxy(main): ' + (e && e.message));
        });
      }
    }
    if (modeEventPayload) {
      const events = g.getEvents();
      if (events) { try { events.append(BRAND.EVENT_HARNESS_REMOTE_CHANGED, modeEventPayload); } catch {} }
    }
  }

  return {

    setRemoteMode(id, mode) {
      if (mode !== 'off' && mode !== 'lan' && mode !== 'wan') {
        return { ok: false, error: 'mode 必须显式给出（off|lan|wan）' };
      }
      const target = resolveTarget(id);
      if (!target) return { ok: false, error: '实例不存在' };
      const allocate = mode !== 'off' && !String(target.remoteToken || '').trim();
      const nextToken = allocate ? generateRemoteToken() : target.remoteToken;
      if (mode === 'wan') {
        const v = validateWanAccess({ remoteToken: nextToken });
        if (!v.ok) return { ok: false, error: v.error };
      }
      if (target.kind === 'main') {
        const patch = { remoteMode: mode };
        if (allocate) patch.remoteToken = nextToken;
        if (allocate || target.mode !== mode) {
          applyMainIntent(patch, { id: 'main', name: '原生 DSH', mode });
          if (allocate) {
            const events = g.getEvents();
            if (events) { try { events.append(BRAND.EVENT_HARNESS_REMOTE_TOKEN_CHANGED, { id: 'main', tokenSet: true, autoAllocated: true }); } catch {} }
          }
        }
        return { ok: true, tokenAutoAllocated: allocate };
      }
      const r = allocate
        ? g.getInstances().updateInstance(id, { remoteMode: mode, remoteToken: nextToken })
        : g.getInstances().updateInstance(id, { remoteMode: mode });
      if (r && r.ok !== false) r.tokenAutoAllocated = allocate;
      return r;
    },

    setRemoteToken(id, token) {
      if (typeof token !== 'string') {
        return { ok: false, error: 'token 必须显式给出（空串=清除）' };
      }
      const next = token;
      if (next && !remoteTokenStrength(next).ok) {
        return { ok: false, error: '远程访问令牌（remoteToken）至少 8 位' };
      }
      const target = resolveTarget(id);
      if (!target) return { ok: false, error: '实例不存在' };
      if (target.kind === 'main') {
        applyMainIntent({ remoteToken: next }, null);
        const events = g.getEvents();
        if (events) { try { events.append(BRAND.EVENT_HARNESS_REMOTE_TOKEN_CHANGED, { id: 'main', tokenSet: next !== '' }); } catch {} }
        return { ok: true };
      }
      return g.getInstances().updateInstance(id, { remoteToken: next });
    },

    lanFrpc(action, body) {
      if (g.getDaemons().enabled() ) return g.getCtl().lanCall('frpAction', [action, body]);
      const lan = lanModule(g);
      if (!lan || typeof lan.frpAction !== 'function') return Promise.resolve({ ok: false, error: '远程控制模块未注册（lan），拒绝本地写' });
      return lan.frpAction(action, body);
    },

    syncFrpc() {
      if (g.getDaemons().enabled() ) { g.getCtl().lanCall('syncFrpc').catch(() => {}); return; }
      const lan = lanModule(g);
      if (lan && typeof lan.syncFrpc === 'function') lan.syncFrpc();
    },
  };
}

module.exports = { createLanActions };
