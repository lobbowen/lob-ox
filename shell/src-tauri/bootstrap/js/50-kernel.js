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
            
      if (p.error) {
        NS.fail('内核版本检查失败：' + p.error);
        return null;
      }
      var mt = p.registry ? String(p.registry).replace(/^https?:\/\
      NS.status('内核已是最新（v' + p.installed + '）' + (mt ? ' · 源 ' + mt : ''));
      NS.coreVersion = p.installed;
      return NS.wait(300).then(NS.stepCoreDone);
    }).catch(function (e) { NS.fail('内核版本检查失败：' + NS.errText(e)); });
  }

  function coreApply() {
        
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
        
    return NS.withTimeout(NS.core.invoke('core_apply'), NS.coreApplyBudgetMs(), '内核安装超时（已中止等待）').then(function (r) {
      if (r && r.__timeout) return coreApplyPoll(0);
      if (r && r.__error) { NS.fail('内核安装异常：' + r.__error); return false; }
      if (!r || r.ok !== true) {
        NS.fail('内核' + ((NS.lastPlan && NS.lastPlan.installed) ? '更新' : '安装') + '失败：' + ((r && r.error) || '未知错误'));
        return false;
      }
      NS.coreVersion = r.version;
      return NS.core.invoke('core_status').then(function (st) {
        st = st || {};
        if (st.version === r.version) return NS.stepCoreDone();
        NS.fail('内核已安装 v' + r.version + '，但检测到的是 v' + (st.version || '未知') + '（安装前缀不一致）');
        return false;
      });
    }).catch(function (e) { NS.fail('内核安装异常：' + NS.errText(e)); return false; });
  }

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
    NS.install.done('kernel', NS.coreVersion);
    return NS.wait(300).then(NS.stepGuardStart);
  }

  NS.stepCorePlan = stepCorePlan;
  NS.coreApply = coreApply;
  NS.stepCoreDone = stepCoreDone;
})(window.__BOOT_NS);
