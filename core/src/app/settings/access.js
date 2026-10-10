'use strict';

const fs = require('node:fs');

function verifyPersisted(configPath, patch) {
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (e) {
    return '配置读取核验失败: ' + e.message;
  }
  for (const name of Object.keys(patch)) {
    if (doc[name] !== patch[name]) return '配置未落盘: ' + name;
  }
  return null;
}

module.exports = {
  methods: {
    accessKeyStatus() {
      const cfg = this.config || {};
      return { configured: !!cfg.apiAccessKey, host: cfg.apiHost || undefined };
    },

        
    setAccessKey(key) {
      try {
        const cfg = this.config || {};
        const k = typeof key === 'string' ? key.trim() : '';
        if (k && k.length < 8) return { ok: false, error: '访问密钥至少 8 位（建议 16+ 位随机串）' };
        cfg.apiAccessKey = k || null;
        const patch = { apiAccessKey: k || null };
        const lanClosed = !k && !!cfg.apiHost && cfg.apiHost !== '127.0.0.1';
        if (lanClosed) {
          cfg.apiHost = '127.0.0.1';
          patch.apiHost = '127.0.0.1';
        }
        if (this.configPath) {
          this.state.persistConfigPatch(patch);
          const persistError = verifyPersisted(this.configPath, patch);
          if (persistError) return { ok: false, error: persistError };
        }
        if (this.events) this.events.append('access_key_changed', { configured: !!k, lanClosed });
        return { ok: true, configured: !!k, lanClosed, host: cfg.apiHost || undefined };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    },

    closeActionStatus() {
      const cfg = this.config || {};
      const v = cfg.closeAction;
      return { closeAction: (v === 'exit') ? 'exit' : 'hide' };
    },

    setCloseAction(v) {
      try {
        const val = (v === 'exit') ? 'exit' : 'hide';
        const cfg = this.config || {};
        cfg.closeAction = val;
        if (this.configPath) {
          this.state.persistConfigPatch({ closeAction: val });
          const persistError = verifyPersisted(this.configPath, { closeAction: val });
          if (persistError) return { ok: false, error: persistError };
        }
        if (this.events) this.events.append('close_action_changed', { closeAction: val });
        return { ok: true, closeAction: val };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    },
  },
  verifyPersisted,
};
