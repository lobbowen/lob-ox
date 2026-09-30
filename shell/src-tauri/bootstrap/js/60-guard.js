// 60-guard：守卫状态与自检结果呈现
// 共享状态与跨模块调用经 NS（window.__BOOT_NS）。
(function (NS) {
  function stepGuardStart() {
    NS.setStep(3);
    NS.phase('guard');
    NS.status('正在启动守卫…');
    // 必须有界。
    // 必须有界：guard_start 内部可能最长约 2 分钟；超时兜底 + 阶段进度上报。
    return NS.withTimeout(NS.core.invoke('guard_start'), NS.GUARD_START_BUDGET_MS, '守卫启动超时').then(function (r) {
      if (r && r.__timeout) return NS.guardFailed('守卫启动超时：' + (r.error || '服务管理器无响应'));
      if (r && r.__error) return NS.guardFailed('守卫启动异常：' + r.__error);
      if (!r || r.ok !== true) {
        // 规范 KERNEL-LAUNCH-STANDARD 第 1 节与第 4 节的前置：磁盘内核未与线上最新对齐 -> 先对齐一次再重试。
        // 只自动对齐一次，避免与内核源不可达形成死循环（第二次仍失败则如实报错）。
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
    // 同样有界：守卫若在启动中，健康探针可能长时间无响应。
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
    // 内核零回退：更新失败即失败，不得回退旧内核（唯一允许回退的是 DSH 自身升级）。
    NS.fail(msg);
    return null;
  }

  function stepPanel() {
    NS.setStep(4);
    NS.phase('ready');   // 关键：这是「壳已健康启动」的确认信号
    NS.status('服务就绪 · 正在进入面板…');
    NS.$('logo').classList.add('done');
    return NS.wait(700).then(function () {
      // 通知 Rust「引导完成 -> 健康确认」（内核据此确认桌面版本更新成功 / 清 journal）
      if (NS.core) NS.core.invoke('finish_boot').catch(function () {});
      // 切到壳框架：主帧导航（shell.html 将成为主帧，其 win_ctl / 面板导航均可用）
      setTimeout(NS.gotoShell, 400);
    });
  }

  // -- 导出到 NS（跨模块可调用）--
  NS.stepGuardStart = stepGuardStart;
  NS.stepGuardReady = stepGuardReady;
  NS.guardFailed = guardFailed;
  NS.stepPanel = stepPanel;
})(window.__BOOT_NS);
