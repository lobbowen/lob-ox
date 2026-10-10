(function (NS) {
    
  function applyToolchain(st) {
    if (!st || st.__timeout || st.probing || st.busy) return;
    var t = NS.emptyToolchain();
    t.node = st.installed || null;
    t.npm = st.npmVersion || null;
    NS.toolchain = t;
  }

    
  function readEnv() {
    return NS.withTimeout(NS.core.invoke('node_status'), 15000, '环境查询无响应').then(function (st) {
      var o = st || {};
      applyToolchain(o);
      return o;
    });
  }

  function toolchainLine() {
    var t = NS.toolchain || NS.emptyToolchain();
    return '环境就绪 · Node ' + (NS.versionLabel(t.node) || '版本未回读') +
      ' · npm ' + (NS.versionLabel(t.npm) || '版本未回读');
  }

  function envProgressLine(st) {
    var parts = [];
    var line = NS.probeSummary(st);
    if (line) parts.push(line);
    var s = st && st.stuck;
    if (s && s.on) parts.push('正在 ' + s.on + ' · 已 ' + Math.round((s.ms || 0) / 1000) + 's 无响应');
    return parts.length ? ' ' + parts.join(' · ') : '';
  }

  function stepEnv() {
    NS.setStep(0);
    NS.phase('env');
    NS.status('正在检测系统环境…');
    var deadline = Date.now() + NS.ENV_PROBE_BUDGET_MS;
    return new Promise(function (resolve) {
      var settled = false;
      function poll() {
        if (settled) return;
                
        NS.readEnv().then(function (st) {
          if (settled) return;
          if (st.__timeout) {
            if (Date.now() >= deadline) { settled = true; NS.failEnvTimeout(NS.lastEnv || {}); resolve(null); return; }
            NS.status('正在检测系统环境…（查询无响应，重试中）');
            setTimeout(poll, 400);
            return;
          }
          NS.lastEnv = st;
          if (st.probeError) {
            settled = true;
            NS.envStuck = st.stuck || null;
            NS.fail('环境探测失败：' + st.probeError + ' · 已探明：' + (NS.probeSummary(st) || '无任何维度结论'));
            NS.$('btnForceNode').style.display = '';
            resolve(null);
            return;
          }
          if (st.probing) {
            var s = st.stuck;
            if (s && s.on) NS.envStuck = s;
            NS.status('正在检测系统环境…' + envProgressLine(st));
            if (Date.now() >= deadline) {
              settled = true;
              NS.failEnvTimeout(st);
              resolve(null);
              return;
            }
            setTimeout(poll, 400);
            return;
          }
          settled = true;
          var p = NS.afterEnv(st);
          if (p && p.then) { p.then(function () { resolve(null); }, function () { resolve(null); }); } else { resolve(null); }
        }).catch(function (e) {
          if (settled) return;
          settled = true;
          NS.fail('环境检测异常：' + NS.errText(e));
          resolve(null);
        });
      }
      poll();
    });
  }

  function failEnvTimeout(st) {
    NS.envStuck = (st && st.stuck) || null;
    var known = NS.probeSummary(st)
      || ((NS.envStuck && NS.envStuck.on)
        ? '卡在 ' + NS.envStuck.on + '（已 ' + Math.round((NS.envStuck.ms || 0) / 1000) + 's 无响应）'
        : '无任何维度结论');
    NS.fail('环境检测超时（探针无响应，可能有异常的可执行文件占位）· 已探明：' + known);
        
    NS.$('btnForceNode').style.display = '';
  }

  function afterEnv(st) {
    if (st.busy) { NS.setStep(0); NS.status(st.status || '正在准备 Node.js 运行环境…'); return NS.stepNodeWait(); }
    if (!st.installed) {
          
          
          
          
      NS.status('正在完备探测系统 Node…');
      return NS.withTimeout(NS.core.invoke('system_node_ready'), 30000, '完备探测无响应').then(function (full) {
        var f = full || {};
            
        NS.core.invoke('boot_trace', { line: 'afterEnv 决定前有界轮询 installed=' + st.installed + ' probing=' + st.probing + '；完备探测 installed=' + f.installed + ' minOk=' + f.minOk + ' npmOk=' + f.npmOk + ' nodePath=' + f.nodePath }).catch(function () {});
        if (f.installed && f.minOk !== false && f.npmOk === true) {
          NS.status('环境就绪 · Node ' + NS.versionLabel(f.installed) + '（系统自带，已复用）');
          return NS.stepNodeDone();
        }
        NS.setStep(0);
        return NS.probeMirrorThen(function () {
          var why = (!f.installed) ? '未检测到 Node.js'
            : (f.minOk === false ? ('Node.js ' + f.installed + ' 低于最低要求（' + (f.minRequired || 'v22.12') + '）')
              : ('缺少/不可用的 npm' + (f.npmWhy ? '（' + f.npmWhy + '）' : '')));
          NS.install.begin('node', why + ' · 正在补全运行环境…');
          return NS.core.invoke('start_node_install').then(function () { return NS.stepNodeWait('node'); });
        });
      }).catch(function (e) {
        NS.fail('系统 Node 完备探测失败：' + NS.errText(e));
        return null;
      });
    }
        
    if (st.minOk === false) {
      NS.setStep(0);
      return NS.probeMirrorThen(function () {
        NS.install.begin('node', 'Node.js ' + st.installed + ' 低于最低要求（' + (st.minRequired || 'v22.12') + '）· 正在升级…');
        return NS.core.invoke('start_node_install').then(function () { return NS.stepNodeWait('node'); });
      });
    }
        
        
    if (st.npmOk !== true) {
      NS.setStep(0);
      return NS.probeMirrorThen(function () {
        NS.install.begin('npm', '检测到缺少/不可用的 npm'
          + (st.npmWhy ? '（' + st.npmWhy + '）' : '')
          + ' · 正在补全工具链…');
        return NS.core.invoke('start_node_install').then(function () { return NS.stepNodeWait('npm'); });
      });
    }
    return NS.stepNodeDone();
  }

    
  function stepNodeWait(kind) {
    NS.phase('node');
    return new Promise(function (resolve) {
      var done = false;
      var t = setInterval(function () {
        NS.readEnv().then(function (st) {
          if (st.__timeout) return;
                    
          if (!st.busy && st.error) { if (!done) { done = true; clearInterval(t); resolve(failOnMissingNpm(kind, st.error)); } return; }
          if (!st.busy && st.installed && st.minOk !== false && st.npmOk === true) { if (!done) { done = true; clearInterval(t); resolve(NS.stepNodeDone()); } }
        }).catch(function () {});
      }, 700);
      setTimeout(function () {
        if (done) return;
        clearInterval(t);
        NS.readEnv().then(function (st) {
          if (!st.busy && st.installed && st.minOk !== false && st.npmOk === true) { done = true; resolve(NS.stepNodeDone()); return; }
          if (!done) { done = true; resolve(failOnMissingNpm(kind, st.error || '安装超时未完成')); }
        }).catch(function () { if (!done) { done = true; resolve(failOnMissingNpm(kind, '安装超时未完成')); } });
      }, 600000);
    });
  }

  function failOnMissingNpm(kind, error) {
    var target = kind === 'npm' ? 'npm' : 'Node.js';
    NS.fail('运行环境安装失败：' + target + ' 未能就绪' + (error ? '（' + error + '）' : '') + ' · 未进入内核安装，请重试或手动安装 Node 官方分发包');
    return null;
  }

  function stepNodeDone() {
    NS.setStep(0);
    NS.status(toolchainLine());
    return NS.wait(350).then(NS.stepShellUpdate);
  }

  NS.readEnv = readEnv;
  NS.stepEnv = stepEnv;
  NS.failEnvTimeout = failEnvTimeout;
  NS.afterEnv = afterEnv;
  NS.stepNodeWait = stepNodeWait;
  NS.failOnMissingNpm = failOnMissingNpm;
  NS.stepNodeDone = stepNodeDone;
})(window.__BOOT_NS);
