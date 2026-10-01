'use strict';

const BRAND = require('../../shared/brand');

function createMainActions(deps) {
  const g = deps || {};
  return {

    patchDshMain(patch) {
      const p = patch || {};
      const state = g.getState();
      const meta = state.readMainMeta();
      const prev = { ...meta };
      if (p.guardian !== undefined) meta.guardian = !!p.guardian;
      state.writeMainMeta(meta);
      try {
        const events = g.getEvents();
        if (p.guardian !== undefined && prev.guardian !== meta.guardian) {
          events.append(BRAND.EVENT_HARNESS_GUARDIAN_CHANGED, { id: 'main', name: '原生 DSH', enabled: meta.guardian === true });
        }
      } catch (e) { const logger = g.getLogger(); logger && logger.warn && logger.warn('patchDshMain event: ' + ((e && e.message) || e)); }
      return { ok: true, main: g.getViews().dshMain() };
    },
  };
}

module.exports = { createMainActions };
