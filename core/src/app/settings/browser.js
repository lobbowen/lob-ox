'use strict';

// 外部打开的浏览器偏好门面（系统级配置）。
// 导出形态 { methods }，方法经 this 协作；落盘唯一入口仍是 state.persistConfigPatch（写后读回核验）。
//
// 为什么要有这一项：「系统说的默认浏览器」与「用户在本产品里选的浏览器」是两件事。
//   前者由操作系统决定，本机可能读得到也可能读不到（策略收紧、新版排版变化）；后者只在系统
//   说不出或说错时才需要人来定一次。旧形态里读不到默认项就是整条链路不弹窗，
//   用户既不知道为什么也没有任何补救入口。
// 校验只认环境表单里的候选 id：判据本身住在表单（checkPreference），本层只管写入与核验 ——
//   不在清单里的值一律拒写：写了也不会生效，与其让配置里躺着一个永不命中的 id，不如当场说清楚
//   「这台机器上没探到它」。

const platform = require('../../platform/os/index');
// 写后读回核验与 access/lan-panel 同一口径（不各写各的）。
const { verifyPersisted } = require('./access');

module.exports = {
  methods: {
    /** 当前偏好 + 候选清单 + 这一拍的分发依据（面板据此渲染选择器并说明「现在实际会用谁」）。 */
    externalBrowserStatus() {
      try {
        const form = platform.environment.form();
        const v = platform.environment.checkPreference(platform.environment.preferenceId(), form);
        return {
          ok: true,
          configured: !!form.preference && form.preference.configured === true,
          value: (form.preference && form.preference.id) || null,
          // stale=true：偏好所指已不在候选清单（被卸载/路径失效），本次分发已回落，需用户重选。
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

    /** 设置/清除浏览器偏好（空串=清除，回到「按系统默认或候选次序分发」）。 */
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
        // 表单缓存必须一起失效：否则下一拍仍按旧偏好分发（面板会显示新值却用着旧浏览器）。
        platform.environment.invalidate();
        if (this.events) this.events.append('external_browser_changed', { id: v.id, name: v.browser ? v.browser.name : null });
        return { ok: true, configured: !!v.id, value: v.id, browser: v.browser };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    },
  },
};
