(function (NS) {
  function stepGuardStart() {
    NS.setStep(3);
    NS.phase('guard');
    NS.status('正在启动守卫…');
        
    return NS.withTimeout(NS.core.invoke('guard_start'), NS.GUARD_START_BUDGET_MS, '守卫启动超时').then(function (r) {
      if (r && r.__timeout) return NS.guardFailed('守卫启动超时：' + (r.error || '服务管理器无响应'));
      if (r && r.__error) return NS.guardFailed('守卫启动异常：' + r.__error);
      if (!r || r.ok !== true) {
                
        if (r && r.code === 'KERNEL_NOT_ALIGNED' && !NS._alignRetried) {
          NS._alignRetried = true;
          NS.status('内核未与线上对齐 · 正在对齐…');
          return NS.coreApply();
        }
        return NS.guardFailed('守卫启动失败：' + ((r && r.error) || '未知'));
      }
      return NS.stepGuardReady(0);
    }).catch(function (e) { return NS.guardFailed('守卫启动异常：' + NS.errText(e)); });
  }

  function stepGuardReady(n) {
    if (n === 0) NS.status('等待服务就绪…');
    return NS.withTimeout(NS.core.invoke('guard_ready'), 10000, '守卫就绪探测无响应').then(function (r) {
      if (r && r.__timeout) { if (n >= 40) return NS.guardFailed('守卫未就绪（健康探针持续无响应）'); return NS.wait(500).then(function () { return NS.stepGuardReady(n + 1); }); }
      r = r || {};
      if (r.ready) return NS.stepPanel();
      if (n >= 40) return NS.guardFailed('守卫未就绪（端口 ' + (r.port || '?') + ' 无响应）');
      return NS.wait(500).then(function () { return NS.stepGuardReady(n + 1); });
    }).catch(function () {
      if (n >= 40) return NS.guardFailed('守卫就绪探测失败');
      return NS.wait(500).then(function () { return NS.stepGuardReady(n + 1); });
    });
  }

  function guardFailed(msg) {
        
    NS.fail(msg);
    return null;
  }

  function stepPanel() {
    NS.setStep(4);
    NS.phase('ready');
    NS.status('服务就绪 · 正在进入面板…');
    NS.$('logo').classList.add('done');
    return NS.wait(700).then(function () {
      if (NS.core) NS.core.invoke('finish_boot').catch(function () {});
      setTimeout(NS.gotoShell, 400);
    });
  }

  NS.stepGuardStart = stepGuardStart;
  NS.stepGuardReady = stepGuardReady;
  NS.guardFailed = guardFailed;
  NS.stepPanel = stepPanel;
})(window.__BOOT_NS);
