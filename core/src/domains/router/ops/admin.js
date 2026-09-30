'use strict';

// 账号/供应商管理辅助（deps 注入）。

function createAdminOps(deps) {
  const d = deps || {};
  const findProvider = d.findProvider || (() => null);
  const save = d.save || (() => {});
  const ports = d.ports;
  const maskKey = d.maskKey || ((k) => k);
  const logger = d.logger || null;

  /** async：added 需 await 每个 addAccount 的真实结果。 */
  async function setProviderKeys(id, opts) {
    const p = findProvider(id);
    if (!p) return { ok: false, error: '供应商不存在' };
    const rm = new Set((opts && opts.removeMasked) || []);
    const before = (p.accounts || []).length;
    // 删反代账号必须做与 removeProxyKey 同等的收尾（stopInstance/ports/instances）。
    const doomed = (p.accounts || []).filter((a) => rm.has(a.maskedKey));
    if (p.supports('instanceLifecycle')) {
      for (const a of doomed) {
        if (a.instance) {
          // 删除路径必须 force（账号即将摘除，延迟停标记会变不可达，进程泄漏）。
          try { p.stopInstance(a.instance, true); } catch {}
          try { ports.unregister('proxy:' + a.keyId); } catch {}
          a.instance.port = null;
        }
      }
    }
    p.accounts = (p.accounts || []).filter((a) => !rm.has(a.maskedKey));
    if (p.supports('instanceLifecycle')) {
      const gone = new Set(doomed.map((a) => a.keyId));
      p.instances = (p.instances || []).filter((i) => !gone.has(i.keyId));
    }
    const removed = before - p.accounts.length;
    // added 反映真实结果：并发保持 Promise.all 等齐全部结果（不串行）。
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
    // 锁只对可用账号有意义（冻结/额度用尽拒绝锁定）
    if (acc.status !== 'ready' || (typeof p.isAccountUsable === 'function' && !p.isAccountUsable(acc))) {
      return { ok: false, error: '账号当前不可用（' + (acc.status === 'ready' ? '额度用尽' : acc.status) + '），无法锁定' };
    }
    const prevSelected = p.selectedAccountKeyId || null;
    p.selectedAccountKeyId = keyId;
    save();
    // 切换即确保目标就绪（引擎门面，budgetMs=null 等满探活周期——显式切换的启动预算）；
    // 失败回滚 selected 并回收半成品进程（防坏账号粘滞导致 429 循环）。
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
      // 角色变化即回收退位者：期望集重算 + 非期望实例经停止仲裁回收（在途 drain 补刀）。
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
    if (p.supports('instanceLifecycle') && p.accounts[idx].instance) {
      try { p.stopInstance(p.accounts[idx].instance, true); } catch {}
      try { ports.unregister('proxy:' + keyId); } catch {}
      p.accounts[idx].instance.port = null;
    }
    p.accounts.splice(idx, 1);
    if (p.supports('instanceLifecycle')) p.instances = (p.instances || []).filter((i) => i.keyId !== keyId);
    save();
    return { ok: true };
  }

  function addProxyKey(providerId, key) {
    const p = findProvider(providerId);
    if (!p || !p.supports('instanceLifecycle')) return { ok: false, error: '供应商不存在或非反代' }; // 文案保持对外口径
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
