// 桌面壳自更新引导步骤。
//
// 后端契约已改：shell_update_check / shell_update_apply 失败时直接 Err(Fault)，
// 不再返回 {ok:false}。此前本文件靠 {__timeout}/{__error}/{ok:false} 三重判定，
// 三个标记要分别处理、话术全在前端拼，且 showUpdRetry 是与 NS.fail 并存的第三套失败 UI。
// 现统一：失败即 catch 里的 Fault，按 level 处置。
(function (NS) {
  function hideUpdChoice() { NS.$('updChoice').style.display = 'none'; }

  // 桌面更新失败**不是**阻断级：内核仍可用，用户可以先继续用旧壳稍后重试。
  // 这正是过去需要独立一套 UI 的原因 —— 但它不该另起一套语义，
  // 只要给 Fault 一个 warn 级别，走 renderFault 的降级路径即可。
  function updDegraded(f) {
    var curVer = (NS.shellId && NS.shellId.version) || 'unknown';
    var target = (NS.updPlan && NS.updPlan.latest) || 'unknown';
    NS.$('updMsg').textContent = NS.faultText(f);
    NS.$('updMeta').textContent = '当前 ' + curVer + ' · 目标 ' + target;
    NS.$('updChoice').style.display = '';
    // 记一条 warn 事件：更新没成这件事必须可回溯，否则用户只会看到「一直不更新」。
    NS.invoke('boot_trace', { line: 'shell-update degraded: ' + JSON.stringify(f) }, 5000)
      .catch(function () {});
    return null;
  }

  function stepShellUpdate() {
    NS.setStep(1);
    NS.phase('shell-update');
    NS.status('正在检查桌面版本…');
    return NS.invoke('shell_identity', {}, 8000).then(function (id) {
      NS.shellId = id;
    }).catch(function () {
      // 读不到自身版本不阻断：后续 shell_update_check 自己会带出版本。
    }).then(function () {
      return NS.invoke('shell_update_check', {}, NS.SHELL_CHECK_BUDGET_MS);
    }).then(function (r) {
      NS.updPlan = r || {};
      if (NS.shellId && NS.shellId.selfUpdateCapable === false) {
        NS.status('当前安装形态不支持自更新，继续');
        return NS.wait(400).then(NS.stepCorePlan);
      }
      if (!NS.updPlan.available) {
        NS.status('桌面壳已是最新（' + ((NS.shellId && NS.shellId.version) || '?') + '）');
        return NS.wait(400).then(NS.stepCorePlan);
      }
      return NS.stepShellApply();
    }).catch(function (e) {
      // 检查失败：桌面壳保持现状，内核照样装 —— 降级继续。
      return updDegraded(NS.normalizeFault(e));
    });
  }

  function stepShellApply() {
    var target = (NS.updPlan && NS.updPlan.latest) || '';
    NS.install.begin('shell', '发现桌面新版本 ' + target + ' · 正在下载…');
    return NS.invoke('shell_update_apply', {}, NS.SHELL_DOWNLOAD_BUDGET_MS).then(function (r) {
      r = r || {};
      if (r.upToDate) return NS.stepCorePlan();
      NS.install.text('shell', '桌面新版本已安装（' + (r.installed || target) + '） · 正在重启…');
      return NS.wait(800).then(function () {
        // 成功后必须重启（进程里跑的还是旧二进制），且重启前不能再抛错 ——
        // 此刻任何拒绝都会把用户留在「已下载但没生效」的中间态。
        NS.invoke('shell_restart', {}, 10000).catch(function () {
          NS.$('updMsg').textContent = '新版本已下载，重启应用后生效。';
          NS.$('updChoice').style.display = '';
        });
      });
    }).catch(function (e) {
      return updDegraded(NS.normalizeFault(e));
    });
  }

  NS.hideUpdChoice = hideUpdChoice;
  NS.stepShellUpdate = stepShellUpdate;
  NS.stepShellApply = stepShellApply;
})(window.__BOOT_NS);