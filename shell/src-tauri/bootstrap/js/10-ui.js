(function (NS) {
  function setStep(i, detail) {
    if (i > NS.cur) NS.cur = i;
    NS.stepNames.forEach(function (id, idx) {
      var el = document.getElementById(id);
      if (!el) return;
      var cls = 'step';
      if (idx < NS.cur) cls += ' done';
      else if (idx === NS.cur) cls += ' active';
      el.className = cls;
      if (detail && idx === NS.cur) {
        var d = el.querySelector('.step-detail');
        if (d) d.textContent = detail;
      }
    });
    NS.$('steps').style.display = '';
  }

  function status(t) { NS.$('status').textContent = t; }
  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function hideFail() { NS.$('fail').style.display = 'none'; }

    
  var INSTALL_TARGET = { node: 'Node.js', npm: 'npm', kernel: '内核', shell: '桌面版本' };
  var INSTALL_STEP = { node: 0, npm: 0, shell: 1, kernel: 2 };
  var INSTALL_FAIL_PREFIX = {
    node: '运行环境安装失败：', npm: '运行环境安装失败：',
    kernel: '内核安装失败：', shell: '桌面版本更新失败：'
  };

  function installTarget(kind) { return INSTALL_TARGET[kind] || '组件'; }

    
  function installMeter(ratio) {
    var el = NS.$('dlMeter');
    if (!el) return;
    var r = (typeof ratio === 'number' && isFinite(ratio)) ? Math.max(0, Math.min(1, ratio)) : null;
    el.style.display = r === null ? 'none' : '';
    if (r !== null) el.value = r;
  }

    
  function versionLabel(v) {
    var s = (v == null ? '' : String(v)).trim();
    if (!s) return '';
    return /^\d/.test(s) ? 'v' + s : s;
  }

  function installBegin(kind, text, ratio) {
    var at = INSTALL_STEP[kind];
        
    if (at != null && at > NS.cur) setStep(at);
    installMeter(ratio);
    status(text || ('正在下载 ' + installTarget(kind) + ' …'));
  }

  function installText(kind, text, ratio) { installMeter(ratio); if (text) status(text); }

  function installDone(kind, text) {
    installMeter(null);
    var v = versionLabel(text);
    status(installTarget(kind) + (v ? ' ' + v : '') + ' 已就绪');
  }

  function installFail(kind, text) {
    installMeter(null);
    fail((INSTALL_FAIL_PREFIX[kind] || '安装失败：') + (text || '未知'));
  }

  function withTimeout(promise, ms, onTimeoutMsg) {
    return new Promise(function (resolve) {
      var done = false;
      var t = setTimeout(function () {
        if (done) return; done = true;
        resolve({ __timeout: true, error: onTimeoutMsg || '操作超时（无响应）' });
      }, ms);
      promise.then(function (v) {
        if (done) return; done = true; clearTimeout(t); resolve(v);
      }, function (e) {
        if (done) return; done = true; clearTimeout(t); resolve({ __error: String(e) });
      });
    });
  }

  function phase(p) {
    try { if (NS.core) NS.core.invoke('shell_set_phase', { phase: p }).catch(function () {}); } catch (e) {}
  }

  function errText(e) {
    if (e === null || e === undefined) return '未知错误';
    if (typeof e === 'string') return e;
    if (e.kind) {
      var detail = e.cause || e.stage || e.kind;
      return e.hint ? (detail + '；' + e.hint) : detail;
    }
    return String(e.message || e);
  }

  function fail(msg) {
    NS.lastError = msg;
    NS.status('启动未完成');
    NS.$('failMsg').textContent = msg;
    NS.$('fail').style.display = '';
        
    if (/网络|镜像|下载|不可达|network|mirror/i.test(String(msg))) {
      NS.showMirror();
    }
  }

    
  function probeVerdict(ok) {
    if (ok === true) return 'ok';
    if (ok === false) return 'no';
    return '?';
  }

  function probeEntry(p) {
    var bits = [];
    if (p.source) bits.push(p.source);
    if (p.target) bits.push(p.target);
    bits.push((p.ms || 0) + 'ms');
    if (p.note) bits.push(p.note);
    return p.probe + ' ' + probeVerdict(p.ok) + '(' + bits.join(' ') + ')';
  }

  function probeList(st) {
    var list = (st && st.probes) || [];
    return list.map(probeEntry).join(' > ');
  }

  function probeSummary(st) {
    var list = (st && st.probes) || [];
    var rank = function (ok) { return ok === true ? 2 : (ok === false ? 0 : 1); };
    var best = {}, order = [];
    list.forEach(function (p) {
      var k = String(p.probe || '?');
      if (!(k in best)) { best[k] = p; order.push(k); return; }
      if (rank(p.ok) > rank(best[k].ok)) best[k] = p;
    });
    return order.map(function (k) { return probeEntry(best[k]); }).join(' · ');
  }

  function diagText() {
    return [
      'node=' + (NS.toolchain && NS.toolchain.node ? versionLabel(NS.toolchain.node) : 'unknown'),
      'npm=' + (NS.toolchain && NS.toolchain.npm ? versionLabel(NS.toolchain.npm) : 'unknown'),
      'core=' + (NS.coreVersion || 'none'),
      'plan=' + (NS.lastPlan ? JSON.stringify(NS.lastPlan) : 'none'),
      'shell=' + (NS.shellId ? (NS.shellId.version + '/' + NS.shellId.installKind + '/capable=' + NS.shellId.selfUpdateCapable) : 'unknown'),
      'shell_update=' + (NS.updPlan ? JSON.stringify({ available: NS.updPlan.available, latest: NS.updPlan.latest, skipped: NS.updPlan.skipped, error: NS.updPlan.error }) : 'none'),
      'env_probes=' + (probeList(NS.lastEnv) || 'none'),
      'env_candidates=' + ((NS.lastEnv && NS.lastEnv.candidates) || 'none'),
      'env_probe_error=' + ((NS.lastEnv && NS.lastEnv.probeError) || 'none'),
            
      'mirror=' + (
        (NS.warmMirror && NS.warmMirror.npmBest)
          ? (String(NS.warmMirror.npmBest).replace(/\/+$/, '') + '/' + NS.warmMirror.npmLatencyMs + 'ms')
          : (NS.lastMirror && NS.lastMirror.mirror
              ? (NS.lastMirror.mirror + '/' + NS.lastMirror.latencyMs + 'ms')
              : (NS.warmTimer ? 'warming（预热中）' : 'none（预热未启动或全部不可达）'))),
      'mirror_node_best=' + ((NS.warmMirror && NS.warmMirror.nodeBest) || 'none'),
      'mirror_npm_best=' + ((NS.warmMirror && NS.warmMirror.npmBest) || 'none'),
      'mirror_probes=' + (
        (NS.warmMirror && NS.warmMirror.npmProbes && NS.warmMirror.npmProbes.length)
          ? NS.warmMirror.npmProbes.map(function (p) { return p.source.replace(/^https?:\/\
          : ((NS.lastMirror && NS.lastMirror.probes && NS.lastMirror.probes.length)
              ? NS.lastMirror.probes.map(function (p) { return p.source + (p.ok ? '(' + p.latencyMs + 'ms)' : '(x)'); }).join(' > ')
              : 'none')),
      'error=' + (NS.lastError || 'none'),
    ].join(' | ');
  }

  NS.setStep = setStep;
  NS.status = status;
  NS.versionLabel = versionLabel;
  NS.wait = wait;
  NS.hideFail = hideFail;
  NS.install = { begin: installBegin, text: installText, done: installDone, fail: installFail, meter: installMeter };
  NS.withTimeout = withTimeout;
  NS.phase = phase;
  NS.errText = errText;
  NS.fail = fail;
  NS.diagText = diagText;
  NS.probeList = probeList;
  NS.probeSummary = probeSummary;
})(window.__BOOT_NS);
