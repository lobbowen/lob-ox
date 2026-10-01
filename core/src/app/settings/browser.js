'use strict';

const platform = require('../../platform/os/index');
const { verifyPersisted } = require('./access');

module.exports = {
  methods: {
    externalBrowserStatus() {
      try {
        const form = platform.environment.form();
        const v = platform.environment.checkPreference(platform.environment.preferenceId(), form);
        return {
          ok: true,
          configured: !!form.preference && form.preference.configured === true,
          value: (form.preference && form.preference.id) || null,
          stale: !!(form.pick && form.pick.stale),
          browser: v.browser,
          candidates: v.candidates,
          pick: form.pick || null,
          platform: form.platform,
        };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    },

    setExternalBrowser(id) {
      try {
        const form = platform.environment.form();
        const v = platform.environment.checkPreference(id, form);
        if (!v.ok) return { ok: false, error: v.error };
        const cfg = this.config || {};
        cfg.externalBrowser = v.id;
        const patch = { externalBrowser: v.id };
        if (this.configPath) {
          this.state.persistConfigPatch(patch);
          const persistError = verifyPersisted(this.configPath, patch);
          if (persistError) return { ok: false, error: persistError };
        }
        platform.environment.invalidate();
        if (this.events) this.events.append('external_browser_changed', { id: v.id, name: v.browser ? v.browser.name : null });
        return { ok: true, configured: !!v.id, value: v.id, browser: v.browser };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    },
  },
};
