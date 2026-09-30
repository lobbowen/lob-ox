// 70-boot：启动引导入口与镜像预热触发
// 共享状态与跨模块调用经 NS（window.__BOOT_NS）。
(function (NS) {
  function boot() {
    // 必须明确报错，不能静默返回：
    // IPC 不可用时必须明确报错与指引（不能静默返回，否则页面停在静态文案）。
    //   现在若 IPC 不可用，直接给出结论与指引。
    if (!NS.core) {
      NS.fail('Tauri IPC 不可用（window.__TAURI__ 缺失）。请重装桌面壳，或反馈此诊断。');
      return;
    }
    NS.hideFail();
    NS.hideUpdChoice();
    NS.cur = -1; NS.toolchain = NS.emptyToolchain(); NS.coreVersion = null; NS.lastError = null; NS.updPlan = null;
    // 诊断状态一并重置：重试后不应残留上一次的追踪（否则诊断会误导排障）。
    // lastMirror 不重置（镜像选择结果与本次重试无关，保留可对比）。
    NS.lastEnv = null; NS.envStuck = null;
    // 「只自动对齐一次」的那枚闩也必须随重置换新：不重置的话，第一次引导失败后点重试，
    //   KERNEL_NOT_ALIGNED 的自动对齐那条路在这份页面生命周期里永久不再走。
    NS._alignRetried = false;
    // 桥契约：内核安装的前端等待上界要以后端事实为准。取不到就沿用兜底值，不阻塞引导。
    NS.core.invoke('shell_bridge_contract').then(function (c) {
      NS.bridge = c || null;
    }).catch(function () {});
    NS.$('btnForceNode').style.display = 'none';
    // 镜像预热**与引导并行**（后台，不阻塞）：任何步骤都可展示当前镜像。
    NS.startMirrorWarmup();
    // 从**环境检测**开始（本地快检查在前）；随后 Node -> 桌面版本 -> 内核 -> 守卫 -> 控制面板。
    NS.stepEnv().catch(function (e) { NS.fail('引导异常：' + NS.errText(e)); });
  }

  // -- 导出到 NS（跨模块可调用）--
  NS.boot = boot;
})(window.__BOOT_NS);
