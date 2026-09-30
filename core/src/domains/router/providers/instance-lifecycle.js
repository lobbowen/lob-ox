'use strict';

// 账号与实例生命周期（providers 叶子）。有状态协作经 provider 显式入参（与 probe.js/restart.js 同形），无隐式 this。

const { INSTANCE_STATES } = require('../model');
const pidlook = require('../../../platform/os/pidlookup');
const carrier = require('../../../platform/os/carrier');
const ports = require('../../../platform/service/ports').shared;
const { accountModel } = require('./model');

/** 实例停止仲裁：在途不停止；付费侧在用保留。 */
function canStopInstance(provider, acc) {
  if (!acc) return true;
  if ((acc.inflight || 0) > 0) return false;
  if (acc.status === 'ready' && provider.isAccountUsable(acc)) {
    if (provider.selectedAccountKeyId === acc.keyId || (provider.activeAccount && provider.activeAccount.keyId === acc.keyId)) return false;
  }
  return true;
}

// 延后停止的有界期限。本地反代进程持有真实上游 key，冻结/非期望
//   实例若被悬挂在途请求无限续命，可活过冻结很久。到期后 force kill（丢在途请求是预期语义）。
const STOP_PENDING_MAX_MS = 5 * 60 * 1000;

/** 实例停止仲裁入口（幂等）：在途/在用 -> 标记待停（请求结束补刀/reconcile 补停）；force 跳过仲裁。 */
function arbitrateStop(provider, inst, force) {
  if (!inst) return;
  const acc = provider.accounts.find((a) => a.keyId === inst.keyId) || null;
  if (acc && !force && !canStopInstance(provider, acc)) {
    const now = Date.now();
    if (!acc._stopPendingSince) acc._stopPendingSince = now;
    // 有界期限：到期不再延后，落入下方 kill 段（reconcile 每拍都会重入此函数看到期限）。
    if (now - acc._stopPendingSince <= STOP_PENDING_MAX_MS) {
      acc._stopPendingUntilIdle = true;
      return;
    }
  }
  if (acc) { acc._stopPendingUntilIdle = false; acc._stopPendingSince = 0; }
  if (!inst.pid) {
    inst.status = INSTANCE_STATES.COLD;
    inst.healthy = false;
    provider._persist();
    return;
  }
  // pid 快照：必须在置 null 前保存，否则 kill(-null)=kill(-0) 会自杀当前进程组
  const pid = inst.pid;
  if (provider._terminatingPids && provider._terminatingPids.size) {
    for (const q of [...provider._terminatingPids]) {
      let al = true;
      try { al = pidlook.isAlive ? pidlook.isAlive(q) : true; } catch { al = false; }
      if (!al) provider._terminatingPids.delete(q);
    }
  }
  try { provider._terminatingPids.add(pid); } catch {}
  // 停止经载体：POSIX 组信号整树 + 1.5s 有界升级 SIGKILL；win32 无进程组语义，直接
  //   kill 只打得到 .cmd/npx 壳、子孙 node 照旧占端口，由 platform/os/process#killTree
  //   的 taskkill /T /F 补平（PROXY-ISOLATION-STANDARD L1）。
  carrier.signalTermination(pid);
  inst.pid = null;
  inst.status = INSTANCE_STATES.COLD;
  inst.healthy = false;
  provider._persist();
}

/** 请求结束补刀：待停且已无在途 -> 立即停。 */
function retryPendingStop(provider, acc) {
  if (!acc || !acc._stopPendingUntilIdle) return;
  if ((acc.inflight || 0) > 0) return;
  const inst = provider.instanceOf(acc);
  if (inst && inst.pid) { arbitrateStop(provider, inst); }
  else { acc._stopPendingUntilIdle = false; acc._stopPendingSince = 0; }
}

/** 等待区回收执行体（经 process-pool#reclaimAccount 门面调用）：force 终止进程 + 释放端口登记与
 *  绑定——冻结/封号/删号后账号在进程层面零存在。丢弃在途属预期语义（发不出请求的账号不该继续占
 *  进程，裁决：冻结零宽限）。幂等：无进程时只补端口释放。 */
function reclaimAccount(provider, acc) {
  if (!acc) return;
  const inst = provider.instanceOf(acc);
  if (inst) { try { arbitrateStop(provider, inst, true); } catch {} }
  try { ports.unregister('proxy:' + acc.keyId); } catch {}
  if (inst) inst.port = null;
  provider._persist();
}

async function waitHealthy(provider, inst, tries) {
  const n = tries === undefined ? 6 : tries;
  for (let i = 0; i < n; i++) {
    await provider.healthInstance(inst);
    if (inst.healthy) return true;
    // 只有「进程已不在」（COLD）才无望等待；DEAD/WARM 仍可重试（进程在但启动慢）
    if (inst.status === INSTANCE_STATES.COLD) return false;
    await new Promise((r) => setTimeout(r, 1500));
  }
  return false;
}

function isAccountUsable(provider, acc, opts) {
  if (!acc || acc.status !== 'ready') return false;
  if (provider._isCreditsLow(acc)) return false;
  const inst = acc.instance || (provider.instances || []).find((i) => i.keyId === acc.keyId);
  if (!inst) return false;
  if (opts && opts.checkWindows === false) return true;
  return !provider._windowExhausted(acc);
}

/** 加账号：建实例、启动、探活、配额检测，最后经统一 applyDetection 入库。 */
async function addAccount(provider, key, extra) {
  const existing = provider.accounts.find((a) => a.key === key);
  if (existing) return { ok: true, account: existing, already: true };
  const inst = await provider.ensureInstance(key);
  const acc = accountModel(key, { instance: inst, ...(extra || {}) });
  provider.accounts.push(acc);
  provider._persist();
  try { await provider._ensurePkgCached(provider.app); } catch {}
  const r = await provider.startInstance(inst);
  if (!r.ok) {
    acc.status = 'discarded';
    acc.detectError = r.error;
    provider._persist();
    return { ok: false, error: r.error, account: acc };
  }
  const healthy = await waitHealthy(provider, inst);
  if (!healthy) {
    acc.status = 'discarded';
    acc.detectError = '实例启动失败（探活超时）';
    provider._persist();
    return { ok: false, error: acc.detectError, account: acc };
  }
  const det = await provider.detectInstanceQuota(inst);
  if (!det.ok && !det.quota) {
    acc.status = 'discarded';
    acc.detectError = det.error || '无法获取配额';
    provider._persist();
    return { ok: false, error: acc.detectError, account: acc };
  }
  acc.quota = det.quota || null;
  inst.quota = det.quota || null;
  const summary = provider.accountQuotaSummary(acc);
  // 统一入库：与 base 共用 applyDetection 状态机；受限冻结的进程/端口回收由 setStatus 的
  // _onStatusTransition 钩子按事件表自动接线，此处不重复。
  provider.applyDetection(acc, { ok: true, quota: det.quota || null });
  if (acc.status === 'ready' && provider.events) provider.events.append('account_ready', { provider: provider.name, key: acc.maskedKey });
  const limited = (acc.limit && acc.limit.kind) || null;
  return { ok: true, account: acc, review: false, ...(limited ? { limited } : {}), quota: summary };
}

module.exports = { canStopInstance, arbitrateStop, retryPendingStop, reclaimAccount, waitHealthy, isAccountUsable, addAccount };
