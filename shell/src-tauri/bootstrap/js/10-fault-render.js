// 唯一失败呈现：按 Fault 的 level 决定阻断、降级还是仅记录。
//
// 此前三套并行的失败 UI 语义互不相同：
//   showFatal   写 boot_trace、只显示一次、**不退出**；
//   NS.fail     **不写日志**、停在引导页、可重试；
//   showUpdRetry 第三套，只服务桌面自更新。
// 三套对「同一件事算不算致命」的判断互不一致 —— 这正是 unhandledrejection
// 把 ACL 拒绝升级成 fatal 的背景：没有任何一层声明过什么叫致命。
//
// 本层是唯一入口：fault.level 由后端 Fault 词表给出，前端不再自行推断。
(function (NS) {

  function el(id) {
    try { return document.getElementById(id); } catch (e) { return null; }
  }

  function show(id) {
    var e = el(id);
    if (e) { try { e.style.display = 'block'; } catch (x) {} }
  }
  function hide(id) {
    var e = el(id);
    if (e) { try { e.style.display = 'none'; } catch (x) {} }
  }
  function setText(id, t) {
    var e = el(id);
    if (e) { try { e.textContent = String(t); } catch (x) {} }
  }

  /** 故障的一句话陈述：detail + hint（hint 面向用户可操作）。 */
  function describe(f) {
    if (!f) return '未知错误';
    var d = f.detail || f.code || '未知错误';
    return f.hint ? (d + '\n' + f.hint) : d;
  }

  /**
   * 唯一失败呈现。
   *   fatal / error —— 阻断：显示错误面板并停止引导（不退出进程，见下）；
   *   warn          —— 降级：横幅提示，应用继续运行。
   *
   * 关于「不退出」：壳此前靠重启自愈，但把每个失败都升级成退出后重启，
   * 会让一次拖不动标题栏变成无限重启循环。真正需要终止的是内核/Node 环境
   * 这类「继续下去必然不可用」的情形，由 call site 决定是否 shutdown，
   * 呈现层只负责如实告知。
   */
  function render(f, opts) {
    f = NS.normalizeFault(f);
    NS.lastError = describe(f);
    NS.lastFault = f;
    var level = f.level || 'error';
    if (level === 'warn') {
      show('degraded');
      setText('degradedText', describe(f));
      // 本页（shell.html）只做桥转发，没有 status/镜像 UI —— 显式判存在，
      // 免得依赖 TypeError 被 catch 吞掉、掩盖真实问题。
      try { if (NS.status) NS.status('部分功能不可用：' + (f.detail || f.code)); } catch (e) {}
      // 网络类降级仍要给镜像设置入口 —— 与 fail() 的既有行为一致。
      if (/network|net\.|mirror|网络|镜像/i.test(f.code || '')) {
        try { if (NS.showMirror) NS.showMirror(); } catch (e) {}
      }
      return f;
    }
    // 阻断级：先留痕再呈现。boot_trace 是「复现时读事实而不是推断」的通道。
    try {
      NS.invoke('boot_trace', { line: 'fatal[' + level + '] ' + f.code + ': ' + (f.detail || '') })
        .catch(function () {});
    } catch (e) {}
    try {
      NS.invoke('shell_set_phase', { phase: 'error' }).catch(function () {});
    } catch (e) {}
    show('fail');
    setText('failMsg', describe(f));
    hide('degraded');
    try { if (NS.status) NS.status('启动未完成'); } catch (e) {}
    if (/network|net\.|mirror|网络|镜像/i.test(f.code || '')) {
      try { if (NS.showMirror) NS.showMirror(); } catch (e) {}
    }
    if (opts && opts.fatalUi) {
      show('fatal');
      setText('fatalText', describe(f));
    }
    return f;
  }

  // 降级横幅可手动收起：它不该一直占着顶部干扰用户，但故障本身仍在事件流里可查。
  (function wireDegraded() {
    var b = el('degradedClose');
    if (b) b.addEventListener('click', function () { hide('degraded'); });
  })();

  NS.renderFault = render;
  NS.faultText = describe;

  /**
   * 全局异常入口。**只处理非 Fault 的异常** —— 后端 Fault 都带 level，
   * 由各调用点按 level 自行处置，不在此处一刀切成 fatal。
   * 剩下的（真正的脚本错误、无法判定的异常）才是 fatal。
   */
  function onUnexpected(e, kindLabel) {
    var f = NS.normalizeFault(e);
    if (f.code === 'unknown' || f.code === 'client.uncaught') {
      f = NS.fault('client.uncaught', kindLabel + '：' + (f.detail || '未知错误'), 'fatal',
        '这是界面层的未预期错误。请复制诊断信息以便定位。');
    }
    return render(f, { fatalUi: true });
  }
  NS.onUnexpected = onUnexpected;

  window.addEventListener('error', function (e) {
    var where = (e && e.filename ? e.filename + ':' + e.lineno : 'unknown');
    onUnexpected(e && e.message, '界面脚本错误（' + where + '）');
  });
  window.addEventListener('unhandledrejection', function (e) {
    // 带 level 的 Fault 说明它来自后端词表，处置权在调用点；
    // 这里只兜底「谁都没接住」的那些 —— 按 warn 呈现，不终止应用。
    var f = NS.normalizeFault(e && e.reason);
    if (f.code !== 'unknown') {
      NS.renderFault(f);
      return;
    }
    onUnexpected(e && e.reason, '未处理的异步错误');
  });
})(window.__BOOT_NS);