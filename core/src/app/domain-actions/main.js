'use strict';

// app/domain-actions/main.js —— 原生 DSH(main) 域写动作（facade 只读，写动作下沉至此）。
// 实现只经注入的惰性 deps 取事实；装配侧（app/assembly/facets.js）把方法平铺装到 host，消费面不变。
// 本补丁只持守卫元数据（guardian）；远程控制意图（remoteMode/remoteToken）的唯一写入口在
// app/domain-actions/lan.js#setRemoteMode/setRemoteToken，不再经设置面旁路。

/** patchDshMain 工厂。
 *  @param deps { getState, getViews, getLogger } 全为惰性取值。 */
function createMainActions(deps) {
  const g = deps || {};
  return {

    /** main 元数据补丁(白名单: guardian)。 */
    patchDshMain(patch) {
      const p = patch || {};
      const state = g.getState();
      const meta = state.readMainMeta();
      const prev = { ...meta };
      if (p.guardian !== undefined) meta.guardian = !!p.guardian;
      state.writeMainMeta(meta);
      // 开关变更写事件日志，供审计回放
      try {
        const events = g.getEvents();
        if (p.guardian !== undefined && prev.guardian !== meta.guardian) {
          events.append('dsh_guardian_changed', { id: 'main', name: '原生 DSH', enabled: meta.guardian === true });
        }
      } catch (e) { const logger = g.getLogger(); logger && logger.warn && logger.warn('patchDshMain event: ' + ((e && e.message) || e)); }
      return { ok: true, main: g.getViews().dshMain() };
    },
  };
}

module.exports = { createMainActions };
