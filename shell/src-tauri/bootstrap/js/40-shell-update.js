(function (NS) {
  function hideUpdChoice() { NS.$('updChoice').style.display = 'none'; }
  function showUpdRetry(reason) {
    var curVer = (NS.shellId && NS.shellId.version) || "unknown";
    var target = (NS.updPlan && NS.updPlan.latest) || "unknown";
    NS.$('updMsg').textContent = reason || "桌面版本更新未完成";
    NS.$('updMeta').textContent = "当前 " + curVer + " · 目标 " + target;
    NS.$('updChoice').style.display = '';
    return null;
  }
  function stepShellUpdate() {
    NS.setStep(1);
    NS.phase('shell-update');
    NS.status('正在检查桌面版本…');
    return NS.withTimeout(NS.core.invoke('shell_identity'), 8000, '读取桌面壳版本超时').then(function (id) {
      if (id && !id.__timeout && !id.__error) NS.shellId = id;
      return NS.withTimeout(NS.core.invoke('shell_update_check'), NS.SHELL_CHECK_BUDGET_MS, '检查超时（网络不可达？）');
    }).then(function (r) {
      r = r || {};
      if (r.__timeout) return showUpdRetry('桌面版本检查超时（网络不可达？）');
      if (r.__error) return showUpdRetry('桌面版本检查异常：' + r.__error);
      if (r.ok === false) return showUpdRetry('桌面版本检查失败：' + (r.error || '未知'));
      NS.updPlan = r;
            
      if (NS.shellId && NS.shellId.selfUpdateCapable === false) {
        NS.status('当前安装形态不支持自更新，继续');
        return NS.wait(400).then(NS.stepCorePlan);
      }
      if (r.available !== true) {
        NS.status('桌面壳已是最新（' + ((NS.shellId && NS.shellId.version) || '?') + '）');
        return NS.wait(400).then(NS.stepCorePlan);
      }
      return NS.stepShellApply();
    });
  }
  function stepShellApply() {
    var target = (NS.updPlan && NS.updPlan.latest) || '';
    NS.install.begin('shell', '发现桌面新版本 ' + target + ' · 正在下载…');
    return NS.withTimeout(NS.core.invoke('shell_update_apply'), NS.SHELL_DOWNLOAD_BUDGET_MS, '下载长时间无进展')
      .then(function (r) {
        r = r || {};
        if (r.__timeout) return showUpdRetry(r.error || '下载超时');
        if (r.__error) return showUpdRetry('桌面版本调用异常：' + r.__error);
        if (r.ok !== true) return showUpdRetry('桌面版本更新失败：' + (r.error || '未知'));
        if (r.upToDate) return NS.stepCorePlan();
        NS.install.text('shell', '桌面新版本已安装（' + (r.installed || target) + '） · 正在重启…');
        return NS.wait(800).then(function () { return NS.core.invoke('shell_restart'); });
      });
  }
  NS.hideUpdChoice = hideUpdChoice;
  NS.showUpdChoice = showUpdRetry;
  NS.showUpdRetry = showUpdRetry;
  NS.stepShellUpdate = stepShellUpdate;
  NS.stepShellApply = stepShellApply;
})(window.__BOOT_NS);
