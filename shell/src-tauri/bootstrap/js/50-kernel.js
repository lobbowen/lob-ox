// 50-kernel：内核版本计划与安装过程呈现。
// 共享状态与跨模块调用经 NS（window.__BOOT_NS）。
(function (NS) {
  function stepCorePlan() {
    NS.setStep(2);
    NS.phase('kernel');
    NS.status('正在检查内核版本…');
    return NS.withTimeout(NS.core.invoke('core_plan'), NS.CORE_PLAN_BUDGET_MS, '内核版本检查超时（网络不可达？）').then(function (p) {
      if (p && p.__timeout) { NS.fail('内核版本检查超时（网络不可达？）'); return null; }
      if (p && p.__error) { NS.fail('内核版本检查异常：' + p.__error); return null; }
      NS.lastPlan = p || {};
      if (!p.installed) {
        NS.install.begin('kernel', '未安装内核 · 正在安装标准产品包…' + (NS.mirrorText() ? '（源 ' + NS.mirrorText() + '）' : ''));
        return NS.coreApply();
      }
      if (p.action === 'upgrade' && p.latest) {
        NS.install.begin('kernel', '发现新内核 v' + p.latest + '（当前 v' + p.installed + '）· 正在强制更新…');
        return NS.coreApply();
      }
      // 远端版本查询失败必须如实告知：build_plan 在 latest 查询失败时给出 action=unknown 且带
      // error 原因；installed 非空时若不看 p.error，就会把「这次根本没查成」报成「内核已是最新」，
      // 抹掉用户唯一的网络诊断线索。故停在当前阶段，报因并给重试，不得继续。
      if (p.error) {
        NS.fail('内核版本检查失败：' + p.error);
        return null;
      }
      // 显示实际命中的镜像：
      //   core_plan 早就回传了 registry 字段，但前端从未使用 —— 数据链路断了。
      var mt = p.registry ? String(p.registry).replace(/^https?:\/\//, '') : NS.mirrorText();
      NS.status('内核已是最新（v' + p.installed + '）' + (mt ? ' · 源 ' + mt : ''));
      NS.coreVersion = p.installed;
      return NS.wait(300).then(NS.stepCoreDone);
    }).catch(function (e) { NS.fail('内核版本检查失败：' + NS.errText(e)); });
  }

  function coreApply() {
    // 后端 core_apply 不收版本参数（目标版本由 Rust 自己按 latest 解析），故这里不传 version。
    // 在飞互斥：boot 链、guard 的 KERNEL_NOT_ALIGNED 自动对齐、btnRetry 都会再打这条命令，
    //   而 npm 安装不是幂等的可重入操作 —— 与 shell.html 面板桥那条路同款互斥，缺了就并发写同一前缀。
    if (NS.coreApplyPending) {
      NS.status('内核安装正在进行中 · 本次不重复发起');
      return Promise.resolve(false);
    }
    NS.coreApplyPending = true;
    return coreApplyOnce().then(function (v) {
      NS.coreApplyPending = false;
      return v;
    }, function (e) {
      NS.coreApplyPending = false;
      throw e;
    });
  }

  function coreApplyOnce() {
    // 有界：上界由 NS.coreApplyBudgetMs() 以后端契约（预算 + 收尾余量）加前端余量得出，
    //   保证前端只会比后端更晚放弃等待。
    return NS.withTimeout(NS.core.invoke('core_apply'), NS.coreApplyBudgetMs(), '内核安装超时（已中止等待）').then(function (r) {
      // withTimeout 只放弃等待、不取消后端：安装仍在跑并可能随后落盘。先按 core_status 判实际结果。
      if (r && r.__timeout) return coreApplyPoll(0);
      if (r && r.__error) { NS.fail('内核安装异常：' + r.__error); return false; }
      if (!r || r.ok !== true) {
        NS.fail('内核' + ((NS.lastPlan && NS.lastPlan.installed) ? '更新' : '安装') + '失败：' + ((r && r.error) || '未知错误'));
        return false;
      }
      NS.coreVersion = r.version;
      // 校验确实生效：防「装到了别的前缀」（跨平台 npm prefix 不一致的典型症状）
      return NS.core.invoke('core_status').then(function (st) {
        st = st || {};
        if (st.version === r.version) return NS.stepCoreDone();
        NS.fail('内核已安装 v' + r.version + '，但检测到的是 v' + (st.version || '未知') + '（安装前缀不一致）');
        return false;
      });
    }).catch(function (e) { NS.fail('内核安装异常：' + NS.errText(e)); return false; });
  }

  // 超时后的实际结果确认：每 15 秒一拍、最多 20 拍（5 分钟）。
  //   升级场景要有 target 可比（装着旧版本不算成功）；全新安装则「装出了任何版本」即成功。
  function coreApplyPoll(n) {
    var plan = NS.lastPlan || {};
    var target = plan.installed ? (plan.latest || null) : null;
    return NS.core.invoke('core_status').then(function (st) {
      st = st || {};
      if (st.version && (!target || st.version === target)) {
        NS.coreVersion = st.version;
        NS.status('内核安装已在后端完成（前端曾中止等待）· v' + st.version);
        return NS.stepCoreDone();
      }
      if (n >= 20) {
        NS.fail('内核安装超时（超过 ' + Math.round(NS.coreApplyBudgetMs() / 60000) + ' 分钟未完成）'
          + (target ? '，检测到的仍是 v' + (st.version || '未知') + '，期望 v' + target : ''));
        return false;
      }
      return NS.wait(15000).then(function () { return coreApplyPoll(n + 1); });
    }).catch(function (e) {
      NS.fail('内核安装超时且状态查询失败：' + NS.errText(e));
      return false;
    });
  }

  function stepCoreDone() {
    NS.setStep(2);
    // 完成文案由安装层统一生成（内核 vX 已就绪），与 install_done 事件同形。
    NS.install.done('kernel', NS.coreVersion);
    return NS.wait(300).then(NS.stepGuardStart);
  }

  // -- 导出到 NS（跨模块可调用）--
  NS.stepCorePlan = stepCorePlan;
  NS.coreApply = coreApply;
  NS.stepCoreDone = stepCoreDone;
})(window.__BOOT_NS);
