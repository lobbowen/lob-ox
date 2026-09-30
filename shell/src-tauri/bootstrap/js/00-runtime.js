// 00-runtime：NS 命名空间、共享状态、全局错误处理与窗口栏。
// 必须最先加载 - onerror / unhandledrejection 未先注册时，后续文件的错误无人捕获（不变量 F2）。
// 按职责分文件让一处语法错不再导致全页不执行；每文件独立语法检查（门禁 G5）。
window.__BOOT_NS = window.__BOOT_NS || {};
(function (NS) {
  NS.core = (window.__TAURI__ && window.__TAURI__.core) || null;
  NS.evt = (window.__TAURI__ && window.__TAURI__.event) || null;
  NS.$ = function (id) { return document.getElementById(id); };
  NS.fatalShown = false;
  NS.cur = -1;
  NS.skipAction = null;
  // 工具链快照（环境步骤的唯一事实源）：node 与 npm **成对**出现，形状只由 emptyToolchain 定义一次。
  //   旧实现是两个散装字段（NS.nodeVer / NS.npmVer），一个声明并重置、另一个只被赋值：
  //   新增收敛点时漏写一个不报错，只让「已就绪」文案少一半，并在重试时残留上一轮的值。
  NS.emptyToolchain = function () { return { node: null, npm: null }; };
  NS.toolchain = NS.emptyToolchain();
  NS.lastEnv = null;
  NS.envStuck = null;
  NS.warmMirror = null;
  NS.warmTimer = null;
  NS.lastMirror = null;
  NS.shellId = null;
  NS.bridge = null;
  NS.coreApplyPending = false;
  NS.updPlan = null;
  NS.lastError = null;
  NS.coreVersion = null;
  NS.lastPlan = null;
  NS.stepNames = ['st-env', 'st-shell', 'st-core', 'st-guard', 'st-panel'];
  NS.SHELL_CHECK_BUDGET_MS = 45000;
  NS.SHELL_DOWNLOAD_BUDGET_MS = 300000;
  NS.ENV_PROBE_BUDGET_MS = 45000;
  NS.CORE_PLAN_BUDGET_MS = 90000;
  NS.GUARD_START_BUDGET_MS = 200000;
  // 内核安装的等待上界 = 后端 maxWaitMs（预算 + 收尾余量）+ 前端余量，取不到契约时退到本常量。
  // 前端不得比后端先放弃：后端仍在装时提前判超时，会把一次其实成功的安装说成失败。
  NS.CORE_APPLY_BUDGET_MS = 1080000;
  NS.CORE_APPLY_MARGIN_MS = 90000;
  NS.coreApplyBudgetMs = function () {
    var mw = (NS.bridge && typeof NS.bridge.maxWaitMs === 'number')
      ? NS.bridge.maxWaitMs : NS.CORE_APPLY_BUDGET_MS;
    return mw + NS.CORE_APPLY_MARGIN_MS;
  };

  function showFatal(text) {
    if (NS.fatalShown) return;
    NS.fatalShown = true;
    try {
      var el = document.getElementById("fatal");
      if (el) {
        el.style.display = "block";
        var t = document.getElementById("fatalText");
        if (t) t.textContent = String(text);
      }
      if (NS.core && NS.core.invoke) {
        try { NS.core.invoke("shell_set_phase", { phase: "error" }); } catch (e) {}
      }
    } catch (e) {}
  }
  function gotoShell() {
    try { window.location.replace('shell.html'); } catch (e) {}
  }

  window.addEventListener("error", function (e) {
    var where = (e && e.filename ? e.filename + ":" + e.lineno : "unknown");
    NS.showFatal("界面脚本错误（" + where + "）：" + ((e && e.message) || "unknown"));
  });
  window.addEventListener("unhandledrejection", function (e) {
    var r = e && e.reason;
    NS.showFatal("未处理的异步错误：" + ((r && (r.message || r)) || "unknown"));
  });
  if (!NS.core || !NS.core.invoke) {
    NS.showFatal("Tauri IPC 不可用：本页面必须在主帧中加载（需要 IPC 的页面不能放在 iframe 内）。");
  }
  (function () {
    var wctl = function (a) {
      if (!NS.core) return;
      try { NS.core.invoke('win_ctl', { action: a }).catch(function () {}); } catch (e) {}
    };
    var bind = function (id, action) {
      var el = document.getElementById(id);
      if (el) el.addEventListener('click', function () { wctl(action); });
    };
    bind('btnMin', 'minimize');
    bind('btnMax', 'toggle-maximize');
    bind('btnClose', 'hide');
    var drag = document.getElementById('dragRegion');
    // 显式拖动（Linux WebKit drag-region 常不生效的可靠替代）
    if (drag) drag.addEventListener('mousedown', function () { wctl('drag'); });
  })();
  if (NS.evt) {
    NS.evt.listen('shell:goto-panel', function () { NS.gotoShell(); });
  }

  // -- 导出到 NS（跨模块可调用）--
  NS.showFatal = showFatal;
  NS.gotoShell = gotoShell;
})(window.__BOOT_NS);
