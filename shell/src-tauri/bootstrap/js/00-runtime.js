window.__BOOT_NS = window.__BOOT_NS || {};
(function (NS) {
  NS.core = (window.__TAURI__ && window.__TAURI__.core) || null;
  NS.evt = (window.__TAURI__ && window.__TAURI__.event) || null;
  NS.$ = function (id) { return document.getElementById(id); };
  NS.fatalShown = false;
  NS.cur = -1;
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
    
  NS.CORE_APPLY_BUDGET_MS = 1080000;
  NS.CORE_APPLY_MARGIN_MS = 90000;
  NS.coreApplyBudgetMs = function () {
    var mw = (NS.bridge && typeof NS.bridge.maxWaitMs === 'number')
      ? NS.bridge.maxWaitMs : NS.CORE_APPLY_BUDGET_MS;
    return mw + NS.CORE_APPLY_MARGIN_MS;
  };

  // 失败呈现已统一到 10-fault-render.js 的 render(Fault)：按 level 分流
  // （fatal 阻断 / warn 降级横幅）。此前这里有三套并行 UI 各自判断"什么算致命"，
  // 且结论互相矛盾 —— 那正是 ACL 拒绝被升级成 fatal 的背景。
  function showFatal(text) {
    NS.renderFault(NS.fault('client.uncaught', String(text), 'fatal',
      '这是界面层的未预期错误。请复制诊断信息以便定位。'), { fatalUi: true });
  }
  function gotoShell() {
    try { window.location.replace('shell.html'); } catch (e) {}
  }

  // 全局 error / unhandledrejection 监听已移到 10-fault-render.js。
  //
  // IPC 可用性检查**不在此处**做：本文件先于 10-fault* 加载，此时
  // NS.renderFault 还不存在，立即调用会二次报错。改由 80-init 在启动时检查，
  // 那是真正要用 IPC 的时刻。
  // 标题栏接线：bootstrap 与 shell.html 两侧共用这一份（此前是逐字重复的两份）。
  NS.bindTitleBar = function () {
    // 窗口动作失败按后端 Fault 的 level 处置，不再静默吞掉：
    // 拖不动标题栏是 acl.denied(warn) —— 横幅提示后应用继续；
    // 此前 .catch(function(){}) 把一切丢掉，ACL 拒绝则由 Tauri 抛成
    // unhandledrejection 再被全局监听升级为 fatal，直接导致壳无限重启。
    var wctl = function (a) {
      NS.invoke('win_ctl', { action: a }).catch(function (e) {
        NS.renderFault(e);
      });
    };
    var bind = function (id, action) {
      var el = document.getElementById(id);
      if (el) el.addEventListener('click', function () { wctl(action); });
    };
    bind('btnMin', 'minimize');
    bind('btnMax', 'toggle-maximize');
    bind('btnClose', 'hide');
    // 显式拖动（Linux WebKit drag-region 常不生效的可靠替代）
    var drag = document.getElementById('dragRegion');
    if (drag) drag.addEventListener('mousedown', function () { wctl('drag'); });
  };
  NS.bindTitleBar();
  if (NS.evt) {
    NS.evt.listen('shell:goto-panel', function () { NS.gotoShell(); });
  }

  NS.showFatal = showFatal;
  NS.gotoShell = gotoShell;
})(window.__BOOT_NS);
