// 10-ui：面板渲染函数集。
// 共享状态与跨模块调用经 NS（window.__BOOT_NS）。
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

  // -- 安装/下载的统一文字出口（SSOT  节 3.2，唯一实现）--
  // 为什么集中在这里：历史上 node / npm / 内核 / 桌面壳各画各的（进度条与纯文字并存），
  //   同一件事在不同阶段长得不一样；而且进度条常与真实进度脱节，反而让人误判「卡死」。
  //   现在文字与条都只从这里出：条只在事件带真分母比值时出现（installMeter），其余一律隐藏。
  var INSTALL_TARGET = { node: 'Node.js', npm: 'npm', kernel: '内核', shell: '桌面版本' };
  // kind 是枚举（SSOT  节 2.4）：它只决定文案目标与步骤条落点，**不改变任何样式**。
  var INSTALL_STEP = { node: 0, npm: 0, shell: 1, kernel: 2 };
  var INSTALL_FAIL_PREFIX = {
    node: '运行环境安装失败：', npm: '运行环境安装失败：',
    kernel: '内核安装失败：', shell: '桌面版本更新失败：'
  };

  function installTarget(kind) { return INSTALL_TARGET[kind] || '组件'; }

  // 进度条的**唯一写入点**：只接受 0..1 的真实比值；null/undefined = 本步骤没有可测分母 -> 隐藏。
  // 为什么绝不把「无分母」画成 0：0 会被读成「还没开始」，于是没有进度的步骤在界面上伪装成
  // 卡在原地的进度 —— 比没有条更误导。比值只能来自事件里的 p.progress（后端 download_line 算出）。
  function installMeter(ratio) {
    var el = NS.$('dlMeter');
    if (!el) return;
    var r = (typeof ratio === 'number' && isFinite(ratio)) ? Math.max(0, Math.min(1, ratio)) : null;
    el.style.display = r === null ? 'none' : '';
    if (r !== null) el.value = r;
  }

  // 版本号形态归一（唯一实现）：Node 契约自带 v，npm 与内核/桌面壳的版本号都不带。
  //   形态规则一旦散落到各播报点，同一行里就会出现两种写法，且每处都可能写错。
  //   未探测到版本时返回 ''，由调用方如实说明（绝不拿别的组件的版本顶替）。
  function versionLabel(v) {
    var s = (v == null ? '' : String(v)).trim();
    if (!s) return '';
    return /^\d/.test(s) ? 'v' + s : s;
  }

  function installBegin(kind, text, ratio) {
    var at = INSTALL_STEP[kind];
    // 只前进、不回退：守卫对齐等场景会在更靠后的阶段调用，回退步骤条会误导进度。
    if (at != null && at > NS.cur) setStep(at);
    installMeter(ratio);
    status(text || ('正在下载 ' + installTarget(kind) + ' …'));
  }

  // ratio 来自事件的 progress 字段：后端发 null 就是「这一步没有分母」，条必须随之消失，
  // 不能让它停在最后一个百分比上（那会被读成下载卡住）。
  function installText(kind, text, ratio) { installMeter(ratio); if (text) status(text); }

  function installDone(kind, text) {
    installMeter(null);
    // 完成文案完全同形：<目标> <版本> 已就绪（SSOT  节 3.2）；形态归一只经 versionLabel 这一处。
    var v = versionLabel(text);
    status(installTarget(kind) + (v ? ' ' + v : '') + ' 已就绪');
  }

  function installFail(kind, text) {
    installMeter(null);
    // 失败必须走既有 fail 面板（含镜像自助出口的自动展开），安装层不另开样式、不吞错。
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


  // 阶段上报：写入 ~/.dsh/shell/identity.json + shell.log，供内核观察与问题定位。

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
    // 网络/镜像类失败 -> **自动展开**镜像设置，让用户一眼看到自助出口；
    // 其余失败（如内核安装报错）不展开，避免噪声。
    // 注意：**不含「超时」** —— 环境检测超时并非网络问题，展开镜像设置会误导用户。
    if (/网络|镜像|下载|不可达|network|mirror/i.test(String(msg))) {
      NS.showMirror();
    }
  }

  // 环境探测记录的唯一渲染出口：维度名与顺序都来自壳侧 domain/probes.rs 的记录表，
  // 前端不持有第二份维度表 - 否则每加一个维度就要在这里再抄一遍拼接代码。
  // `ok` 三态原样显示：true=ok / false=no / 其余=?。把「未知」显示成失败，用户会以为
  // 机器坏了，而它只是探测还没跑到那一步。
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

  // 全量记录（诊断串用）：一条不压缩，排障要看的就是「每个候选各多久、为什么不行」。
  function probeList(st) {
    var list = (st && st.probes) || [];
    return list.map(probeEntry).join(' > ');
  }

  // 逐维度一句话（状态行用）：同一维度的多条记录压缩成「最好的那条结论」。
  // 压缩而不是罗列：node 维度是逐个候选的，全列出来状态行会长到没法读。
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
      // npm 与 node 并列：诊断串只报 node，「npm 探到了没有」就又只能靠读代码猜。
      'npm=' + (NS.toolchain && NS.toolchain.npm ? versionLabel(NS.toolchain.npm) : 'unknown'),
      'core=' + (NS.coreVersion || 'none'),
      'plan=' + (NS.lastPlan ? JSON.stringify(NS.lastPlan) : 'none'),
      'shell=' + (NS.shellId ? (NS.shellId.version + '/' + NS.shellId.installKind + '/capable=' + NS.shellId.selfUpdateCapable) : 'unknown'),
      'shell_update=' + (NS.updPlan ? JSON.stringify({ available: NS.updPlan.available, latest: NS.updPlan.latest, skipped: NS.updPlan.skipped, error: NS.updPlan.error }) : 'none'),
      // 环境探测的根因是环境特有的，
      // 靠读代码无法确定；这份记录表是定位该类问题唯一可靠的手段。
      // 「当前卡在哪一步」也在其中 —— 进行中的步骤以 ok=? 形态带着耗时出现。
      'env_probes=' + (probeList(NS.lastEnv) || 'none'),
      'env_candidates=' + ((NS.lastEnv && NS.lastEnv.candidates) || 'none'),
      'env_probe_error=' + ((NS.lastEnv && NS.lastEnv.probeError) || 'none'),
      // 镜像信息必须始终有值：此前只在「需要下载 Node」时才有，
      // 于是 Node 达标的用户诊断串永远是 mirror=none —— 让人合理地怀疑镜像能力不存在。
      // 现从预热缓存读（与是否需要下载解耦），并在尚未就绪时明确说明「预热中」。
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
          ? NS.warmMirror.npmProbes.map(function (p) { return p.source.replace(/^https?:\/\//, '') + (p.ok ? '(' + p.latencyMs + 'ms)' : '(x)'); }).join(' > ')
          : ((NS.lastMirror && NS.lastMirror.probes && NS.lastMirror.probes.length)
              ? NS.lastMirror.probes.map(function (p) { return p.source + (p.ok ? '(' + p.latencyMs + 'ms)' : '(x)'); }).join(' > ')
              : 'none')),
      'error=' + (NS.lastError || 'none'),
    ].join(' | ');
  }

  // -- 导出到 NS（跨模块可调用）--
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
