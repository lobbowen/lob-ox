(function (NS) {
  NS.$('btnUpdRetry').addEventListener('click', function () {
    NS.hideUpdChoice();
    NS.status('正在重试桌面版本更新…');
    // stepShellApply 内部已把失败转成降级提示（不再抛），这里的 catch 只是兜底。
    NS.stepShellApply().catch(function (e) { NS.renderFault(e); });
  });
  NS.$('btnMirror').addEventListener('click', function () {
    var shown = NS.$('mirrorBox').style.display !== 'none';
    if (shown) { NS.$('mirrorBox').style.display = 'none'; } else { NS.showMirror(); }
  });
  NS.$('btnMirrorProbe').addEventListener('click', function () { NS.loadMirror(); });
  NS.$('btnMirrorSave').addEventListener('click', function () {
    var split = function (v) {
      return String(v || '').split(/[,\n]/).map(function (x) { return x.trim(); }).filter(Boolean);
    };
    var node = split(NS.$('mirrorNode').value);
    var npm = split(NS.$('mirrorNpm').value);
    if (!node.length && !npm.length) { NS.$('mirrorHint').textContent = '请至少填写一项镜像地址'; return; }
    NS.$('mirrorHint').textContent = '正在保存…';
    var jobs = [];
    if (node.length) jobs.push(NS.invoke('mirror_set', { kind: 'node', urls: node }, 15000));
    if (npm.length) jobs.push(NS.invoke('mirror_set', { kind: 'npm', urls: npm }, 15000));
    Promise.all(jobs).then(function () {
      NS.$('mirrorHint').textContent = '已保存，正在重新开始引导…';
      return NS.wait(500);
    }).then(function () {
      NS.hideFail();
      NS.$('mirrorBox').style.display = 'none';
    NS.boot();
    }).catch(function (e) {
      NS.$('mirrorHint').textContent = '保存失败：' + e;
    });
  });
  // IPC 可用性检查放在启动时刻而非 00-runtime 加载时：那时故障层已就位，
  // 且这才是真正要发起第一次调用的时刻。
  if (!NS.core || !NS.core.invoke) {
    NS.renderFault(NS.fault('ipc.unavailable', 'Tauri IPC 不可用', 'fatal',
      '本页面必须在主帧中加载。请完全退出后重新启动桌面壳。'));
    return;
  }
  NS.$('btnRetry').addEventListener('click', function () {
    NS.$('btnForceNode').style.display = 'none';
    NS.boot();
  });
  NS.$('btnForceNode').addEventListener('click', function () {
    NS.hideFail();
    NS.$('btnForceNode').style.display = 'none';
    NS.$('mirrorBox').style.display = 'none';
    NS.setStep(0);
    NS.phase('node');
    NS.status('已跳过环境检测 · 正在准备安装 Node.js…');
    NS.probeMirrorThen(function () {
      return NS.invoke('start_node_install', {}, 120000).then(function () { return NS.stepNodeWait(); });
    });
  });
  // 诊断信息 = 内存快照 + **结构化事件流**。
  // 此前只有内存快照：刷新即清零，看不到跨会话历史，也没有任何级别与来源标注。
  // telemetry_tail 补上后者 —— 用户复制出去的是事实（带时间戳/级别/来源），不是推断。
  NS.$('btnDiag').addEventListener('click', function () {
    var snapshot = NS.diagText();
    NS.status('正在收集事件…');
    NS.invoke('telemetry_tail', { limit: 200 }, 15000).then(function (r) {
      var events = (r && r.text) ? r.text : '(事件流读不到)';
      var text = snapshot + '\n\n--- 壳侧事件流（' + ((r && r.seq) || 0) + ' 条为止）---\n' + events;
      try { if (navigator.clipboard) navigator.clipboard.writeText(text); } catch (e) {}
      NS.status('诊断信息已复制（含事件流 ' + ((r && r.seq) || 0) + ' 条）');
    }).catch(function (e) {
      // 事件流读不到也要把内存快照给出去，不能因为附加信息失败就连基本诊断都没有。
      try { if (navigator.clipboard) navigator.clipboard.writeText(snapshot); } catch (e2) {}
      NS.status('诊断信息已复制（事件流读取失败：' + NS.faultText(e) + '）');
    });
  });
  if (NS.evt) {
    // Rust 发的是 core_progress（guardctl.rs 的 step()）；监听 guard_progress 是死的，
    // guard_start 期间 boot UI 从不显示内核进度。
    NS.evt.listen('core_progress', function (e) {
      var p = e.payload || {};
      if (p.status) NS.status(p.status);
    });
  }
    
  if (NS.evt) {
    NS.evt.listen('install_progress', function (e) {
      var p = e.payload || {};
      NS.install.text(p.kind, p.status, p.progress);
    });
    NS.evt.listen('install_done', function (e) {
      var p = e.payload || {};
      NS.install.done(p.kind, p.version);
    });
    NS.evt.listen('install_error', function (e) {
      var p = (e && e.payload) || {};
      NS.install.fail(p.kind, p.error || '未知');
    });
  }
  NS.boot();
})(window.__BOOT_NS);
