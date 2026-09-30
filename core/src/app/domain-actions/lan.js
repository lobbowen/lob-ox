'use strict';

// app/domain-actions/lan.js —— relay(lan) 域写动作（facade 只读）：远程控制意图的唯一写入口 setRemoteMode/setRemoteToken（main 与沙箱同口、按 id 路由），
// 另有 frpc 门面 lanFrpc（settings/install）与 syncFrpc，实现只经注入的惰性 deps 取事实。本地（非 daemon）模式不直接穿透 lan 改 LanManager，只经 lifecycleManager 的 'lan' 登记项（adapters 注册时挂 module）取用，
// 生命周期登记/视图不被绕开；daemon 模式下本层仍是唯一写入方（写守卫存储后 lanCall 收敛），daemon 只是运行时执行者、不接受意图写入。wan 前置闸单一事实源：domains/relay/core.validateWanAccess（令牌强度）；serverAddr 缺失不拦写入（frpc 执行边界已拒 spawn、视图如实报 reason），避免配置顺序锁死用户。缺失访问令牌的分配口同样在 domains/relay/core.generateRemoteToken（本层只调用，不自己拼随机串）。

const { validateWanAccess, generateRemoteToken } = require('../../domains/relay/core');
// 强度下限是 L0 纯判定（与 relay/instance 域同源）；app->domains 只取纯闸，不触域状态。
const { remoteTokenStrength } = require('../../shared/credential');

/** 经生命周期登记项取本地 LanManager（唯一入口；非 daemon 模式）。
 *  无 lifecycleManager（非守卫/单测上下文）时回退注入的 lan，保证可独立单测。 */
function lanModule(deps) {
  const lm = typeof deps.getLifecycleManager === 'function' ? deps.getLifecycleManager() : null;
  const hostLan = typeof deps.getLan === 'function' ? deps.getLan() : null;
  if (lm && typeof lm.get === 'function') {
    const lc = lm.get('lan');
    if (!lc) return null;
    // 模块挂载在 adapters 注册的 ManagedLifecycle 登记项上（首次经此取用时绑定）。
    if (!lc.module && hostLan) lc.module = hostLan;
    return lc.module || null;
  }
  return hostLan || null;
}

/** setRemoteMode/setRemoteToken/lanFrpc/syncFrpc 工厂。
 *  @param deps { getDaemons, getCtl, getLifecycleManager, getLan, getState, getViews, getInstances, getEvents } 全为惰性取值。 */
function createLanActions(deps) {
  const g = deps || {};

  /** 目标意图记录解析：main 读守卫元数据，沙箱按 id 查实例域受管清单。 */
  function resolveTarget(id) {
    if (id === 'main') {
      const meta = g.getState().readMainMeta();
      return { kind: 'main', mode: meta.remoteMode, remoteToken: meta.remoteToken || '' };
    }
    const insts = g.getInstances();
    const rec = insts && typeof insts.all === 'function' ? insts.all().find((i) => i.id === id) : null;
    return rec ? { kind: 'sandbox', mode: rec.remoteMode, remoteToken: rec.remoteToken || '' } : null;
  }

  /** 意图落盘 + 运行时收敛：main 写守卫元数据并经登记项取 LanManager 执行；
   *  沙箱经实例域 updateInstance（其 onRemoteChange 钩子负责 lan-state/syncProxy 收敛）。 */
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
      if (events) { try { events.append('dsh_remote_changed', modeEventPayload); } catch {} }
    }
  }

  return {

    /** 远程控制模式唯一写入口（off|lan|wan）。mode 必须显式给出——缺省归 'off' 会让
     *  漏字段的请求静默关闭远程控制。
     *  开启（lan|wan）时若该实例压根没有访问令牌，就在这里分配一个并随模式一次落盘：
     *  「开启远程控制」是用户唯一的开远程动作，把「先去别处设令牌」留在流程里，产出的是开关已开、
     *  屏幕无二维码、用户也不知凭据为何的半截状态。已有令牌（含过弱的）一律不覆盖——静默改写
     *  用户自设凭据是另一类事故，弱令牌交给 wan 闸显式拒绝并把用户引到令牌框。
     *  wan 前置闸按**补齐后**的令牌复判：分配在复判之前完成、落盘在复判之后发生，被拒仍零写入。 */
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
          // 自动分配同样要留「令牌已设」的审计事实（载荷只记布尔，TK-5）
          if (allocate) {
            const events = g.getEvents();
            if (events) { try { events.append('dsh_remote_token_changed', { id: 'main', tokenSet: true, autoAllocated: true }); } catch {} }
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

    /** 访问令牌唯一显式写入口。token 必须是字符串：空串=显式清除；缺字段/非字符串=请求方缺陷，
     *  拒绝而非当作清除（漏 token 字段清掉访问凭据是事故，不是语义）。
     *  lan 模式清除后仍然可用（relay 空令牌放行），但下一次写入远程控制模式会由 setRemoteMode 重新分配；
     *  wan 模式的守门由执行边界闸兜住（令牌清空后 syncFrpc 复判不过闸即停隧道）。 */
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
        // 事件只记「是否已设」，绝不带令牌值（TK-5 脱敏纪律）
        if (events) { try { events.append('dsh_remote_token_changed', { id: 'main', tokenSet: next !== '' }); } catch {} }
        return { ok: true };
      }
      return g.getInstances().updateInstance(id, { remoteToken: next });
    },

    /** frpc 门面（settings/install）。返回 Promise（api 域直接 .then）。 */
    lanFrpc(action, body) {
      if (g.getDaemons().enabled() /* daemon 启用即 ctl */) return g.getCtl().lanCall('frpAction', [action, body]);
      const lan = lanModule(g);
      if (!lan || typeof lan.frpAction !== 'function') return Promise.resolve({ ok: false, error: '远程控制模块未注册（lan），拒绝本地写' });
      return lan.frpAction(action, body);
    },

    /** 实例变化后同步 frpc 配置与进程（尽力而为，不抛异常影响主流程）。 */
    syncFrpc() {
      if (g.getDaemons().enabled() /* daemon 启用即 ctl */) { g.getCtl().lanCall('syncFrpc').catch(() => {}); return; }
      const lan = lanModule(g);
      if (lan && typeof lan.syncFrpc === 'function') lan.syncFrpc();
    },
  };
}

module.exports = { createLanActions };
