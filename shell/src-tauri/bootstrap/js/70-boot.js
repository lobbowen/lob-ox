(function (NS) {
  function boot() {
        // 必须明确报错，不能静默返回：IPC 不可用时必须给出结论与指引（否则页面停在静态文案）。
    if (!NS.core) {
      NS.fail('Tauri IPC 不可用（window.__TAURI__ 缺失）。请重装桌面壳，或反馈此诊断。');
      return;
    }
    NS.hideFail();
    NS.hideUpdChoice();
    NS.cur = -1; NS.toolchain = NS.emptyToolchain(); NS.coreVersion = null; NS.lastError = null; NS.updPlan = null;
        // 诊断状态一并重置：重试后不应残留上一次的追踪（否则诊断会误导排障）。lastMirror 不重置（镜像选择结果与本次重试无关，保留可对比）。
    NS.lastEnv = null; NS.envStuck = null;
        // 「只自动对齐一次」的那枚闩也必须随重置换新：不重置的话，第一次引导失败后点重试，KERNEL_NOT_ALIGNED 的自动对齐那条路在这份页面生命周期里永久不再走。
    NS._alignRetried = false;
    NS.core.invoke('shell_bridge_contract').then(function (c) {
      NS.bridge = c || null;
    }).catch(function () {});
    NS.$('btnForceNode').style.display = 'none';
    NS.startMirrorWarmup();
    NS.stepEnv().catch(function (e) { NS.fail('引导异常：' + NS.errText(e)); });
  }

  NS.boot = boot;
})(window.__BOOT_NS);
