(function (NS) {
  function boot() {
        
    if (!NS.core) {
      NS.fail('Tauri IPC 不可用（window.__TAURI__ 缺失）。请重装桌面壳，或反馈此诊断。');
      return;
    }
    NS.hideFail();
    NS.hideUpdChoice();
    NS.cur = -1; NS.toolchain = NS.emptyToolchain(); NS.coreVersion = null; NS.lastError = null; NS.updPlan = null;
        
    NS.lastEnv = null; NS.envStuck = null;
        
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
