'use strict';

function createAdminOps(deps) {
  const d = deps || {};
  const findProvider = d.findProvider || (() => null);
  const save = d.save || (() => {});
  const maskKey = d.maskKey || ((k) => k);
  const logger = d.logger || null;

  
  
  
  
  
  
  function teardownAccount(p, acc) {
    const hook = p._hooks && typeof p._hooks.onDiscardAccount === 'function' ? p._hooks.onDiscardAccount : null;
    if (hook) { try { hook(acc); } catch (e) {  } return; }
    if (acc.instance) acc.instance.port = null;
    p.instances = (p.instances || []).filter((i) => i.keyId !== acc.keyId);
  }

  async function setProviderKeys(id, opts) {
    const p = findProvider(id);
    if (!p) return { ok: false, error: '供应商不存在' };
    const rm = new Set((opts && opts.removeMasked) || []);
    const before = (p.accounts || []).length;
    const doomed = (p.accounts || []).filter((a) => rm.has(a.maskedKey));
    for (const a of doomed) teardownAccount(p, a);
    const removed = before - p.accounts.length;
    const candidates = ((opts && opts.add) || [])
      .map((k) => String(k).trim())
      .filter((t) => t && !p.accounts.some((a) => a.key === t));
    const settled = await Promise.all(candidates.map((t) =>
      Promise.resolve()
        .then(() => p.addAccount(t))
        .catch((e) => ({ ok: false, error: (e && e.message) || String(e) }))
        .then((res) => ({ t, res }))
    ));
    const addedList = [];
    const discardedList = [];
    for (const { t, res } of settled) {
      if (res && res.ok) addedList.push(res.account ? res.account.maskedKey : maskKey(t));
      else discardedList.push({ key: maskKey(t), error: (res && res.error) || '未知错误' });
    }
    save();
    return {
      ok: true,
      keys: p.accounts.length,
      added: addedList.length,
      removed,
      discarded: discardedList.length,
      discardedKeys: discardedList,
    };
  }

  async function setSelectedProxyKey(providerId, keyId) {
    const p = findProvider(providerId);
    if (!p) return { ok: false, error: '供应商不存在' };
    const acc = (p.accounts || []).find((a) => a.keyId === keyId);
    if (!acc) return { ok: false, error: '账号不存在' };
    if (acc.status !== 'ready' || (typeof p.isAccountUsable === 'function' && !p.isAccountUsable(acc))) {
      return { ok: false, error: '账号当前不可用（' + (acc.status === 'ready' ? '额度用尽' : acc.status) + '），无法锁定' };
    }
    const prevSelected = p.selectedAccountKeyId || null;
    p.selectedAccountKeyId = keyId;
    save();
    if (p.supports('instanceLifecycle')) {
      const sv = await p.ensureServable(acc, { budgetMs: null }).catch((e) => ({ ok: false, error: e && e.message }));
      if (!sv || !sv.ok) {
        if (acc.instance && acc.instance.pid) { try { p.stopInstance(acc.instance); } catch {} }
        p.selectedAccountKeyId = prevSelected;
        save();
        const errMsg = '实例启动失败（' + ((sv && sv.error) || '探活超时') + '），已取消切换并回滚';
        if (logger && logger.warn) logger.warn('[select] ' + errMsg + ' key=' + (acc.maskedKey || keyId) + ' sv=' + JSON.stringify(sv));
        return { ok: false, error: errMsg };
      }
      p.reconcileNow();
    }
    return { ok: true, selected: keyId };
  }

  async function switchToKey(providerId, keyId) {
    return setSelectedProxyKey(providerId, keyId);
  }

  function removeProxyKey(providerId, keyId) {
    const p = findProvider(providerId);
    if (!p) return { ok: false, error: '供应商不存在' };
    const idx = (p.accounts || []).findIndex((a) => a.keyId === keyId);
    if (idx < 0) return { ok: false, error: '账号不存在' };
    teardownAccount(p, p.accounts[idx]);
    p.accounts.splice(idx, 1);
    save();
    return { ok: true };
  }

  function addProxyKey(providerId, key) {
    const p = findProvider(providerId);
    if (!p || !p.supports('instanceLifecycle')) return { ok: false, error: '供应商不存在或非反代' };
    return p.addAccount(key);
  }

  function discardAccount(providerId, keyId) {
    const p = findProvider(providerId);
    if (!p) return { ok: false, error: '供应商不存在' };
    return p.discardAccount(keyId);
  }

  return { setProviderKeys, setSelectedProxyKey, switchToKey, removeProxyKey, addProxyKey, discardAccount };
}

module.exports = { createAdminOps };
