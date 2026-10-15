(function (NS) {
  function stepGuardStart() {
    NS.setStep(3);
    NS.phase('guard');
    NS.status('正在启动守卫…');
    // guard_start 失败现在直接 reject 一个 Fault —— 后端不再返回 {ok:false}。
    // 判断依据是 Fault.code 这个稳定标识，而不是 message 文本匹配。
    return NS.invoke('guard_start', {}, NS.GUARD_START_BUDGET_MS).then(function () {
      return NS.stepGuardReady(0);
    }).catch(function (e) {
      var f = NS.normalizeFault(e);
      // 内核缺失是**可自愈**的：先补装内核，再重启守卫。
      if (f.code === 'kernel.missing' && !NS._alignRetried) {
        NS._alignRetried = true;
        NS.status('未检测到已安装内核 · 正在安装…');
        return Promise.resolve(NS.coreApply()).then(function (applied) {
          if (applied === false) {
            NS.renderFault(NS.fault('kernel.missing', '内核安装未完成，守卫无法启动', 'fatal',
              '请检查网络与镜像源设置后点「重试」。'));
            return null;
          }
          return NS.stepGuardStart();
        });
      }
      // 超时是「没等到」，但守卫起不来就无从继续 —— 仍按阻断处理，
      // 话术由 Fault.hint 给出。
      NS.renderFault(f);
      return null;
    });
  }
  function stepGuardReady(n) {
    if (n === 0) NS.status('等待服务就绪…');
    return NS.invoke('guard_ready', {}, 10000).then(function (r) {
      r = r || {};
      if (r.ready) return NS.stepPanel();
      if (n >= 40) return NS.guardFailed('守卫未就绪（端口 ' + (r.port || '?') + ' 无响应）', 'kernel.ready_timeout');
      return NS.wait(500).then(function () { return NS.stepGuardReady(n + 1); });
    }).catch(function () {
      if (n >= 40) return NS.guardFailed('守卫就绪探测失败', 'kernel.daemon_exited_unready');
      return NS.wait(500).then(function () { return NS.stepGuardReady(n + 1); });
    });
  }

  // 守卫阶段无法继续：走统一呈现（fatal 阻断）。此前用的是 NS.fail ——
  // 那套只显示、不写日志、不置 phase，与 showFatal 的语义又不一致。
  function guardFailed(msg, code) {
    NS.renderFault(NS.fault(code || 'guard.start_failed', msg, 'fatal',
      '请查看诊断信息；若持续如此请检查内核安装与网络设置。'));
    return null;
  }

  function stepPanel() {
    NS.setStep(4);
    NS.phase('ready');
    NS.status('服务就绪 · 正在进入面板…');
    NS.$('logo').classList.add('done');
    return NS.wait(700).then(function () {
      NS.invoke('finish_boot', {}, 10000).catch(function () {});
      setTimeout(NS.gotoShell, 400);
    });
  }

  NS.stepGuardStart = stepGuardStart;
  NS.stepGuardReady = stepGuardReady;
  NS.guardFailed = guardFailed;
  NS.stepPanel = stepPanel;
})(window.__BOOT_NS);
