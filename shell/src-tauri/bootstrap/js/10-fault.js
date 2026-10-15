// 统一故障层：唯一的 invoke 入口与唯一的失败呈现。
//
// 此前前端有四套并存、且互相不兼容：
//   · 约 30 处 NS.core.invoke 直调，无封装；
//   · withTimeout 把超时与失败**成功 resolve** 成 {__timeout}/{__error} 哨兵对象，
//     于是每个调用点都要手写 if (r && r.__timeout) 分支（现存 25 处），
//     且哨兵是 resolve 出来的 —— 极易被当成功 payload 用；
//   · 三套失败 UI：showFatal（写日志、只显示一次、不退出）、
//     NS.fail（不写日志、停在引导页）、showUpdRetry（第三套）；
//   · 全局 unhandledrejection 把**所有**未处理拒绝都升级为 fatal ——
//     一个拖不动标题栏的辅助交互就杀掉整个应用（真机无限重启的根因）。
//
// 本层把后端 Fault（{code, level, detail, hint}）作为唯一故障形态：
//   · 超时与失败一律 reject，不再有 resolve 出来的伪成功；
//   · level 决定处置：fatal 阻断、warn 降级继续、error 上报后阻断；
//   · 不带 level 的一律按 fatal（无法判定的异常不假装轻）。
(function (NS) {

  // ── 故障构造 ───────────────────────────────────────────────
  function fault(code, detail, level, hint) {
    return { code: code, level: level || 'error', detail: detail || '', hint: hint || '', data: null };
  }

  /** 超时故障。超时是「没等到」，不是「失败了」—— 但对消费侧同样要处置。 */
  function timeoutFault(ms, what) {
    return fault('client.timeout', what + ' 超时（' + Math.round(ms / 1000) + ' 秒无响应）',
      'error', '该步骤未在预算内完成。可点「重试」重新执行；若持续如此请检查网络与代理设置。');
  }

  /** 把任意 catch 到的值规范成 Fault。 */
  function normalize(e) {
    if (e && typeof e === 'object' && e.code && e.level) return e;
    // 后端 Fault 被 Tauri 包成 { message: "..." } 时，字符串里带序列化后的字段。
    if (e && typeof e === 'object' && typeof e.message === 'string') {
      var m = /"code":"([^"]+)"/.exec(e.message);
      var l = /"level":"([^"]+)"/.exec(e.message);
      var d = /"detail":"([^"]*)"/.exec(e.message);
      var h = /"hint":"([^"]*)"/.exec(e.message);
      if (m) return fault(m[1], d ? d[1] : e.message, l ? l[1] : 'error', h ? h[1] : '');
      return fault('unknown', e.message, 'error', '');
    }
    return fault('unknown', String(e && e.message ? e.message : e), 'error', '');
  }

  // ── 唯一 invoke 入口 ────────────────────────────────────────
  /**
   * 唯一的 IPC 调用入口。超时不再 resolve 成哨兵对象，而是 reject 一个 Fault ——
   * 调用点的 then 分支因此永远只处理「成功」，失败只能出现在 catch 里。
   */
  function invoke(cmd, args, timeoutMs) {
    if (!NS.core || !NS.core.invoke) {
      return Promise.reject(fault('ipc.unavailable', 'Tauri IPC 不可用', 'fatal',
        '本页面必须在主帧中加载。请完全退出后重新启动桌面壳。'));
    }
    var p;
    try {
      p = NS.core.invoke(cmd, args || {});
    } catch (e) {
      return Promise.reject(normalize(e));
    }
    if (!timeoutMs) return p.catch(function (e) { throw normalize(e); });
    return new Promise(function (resolve, reject) {
      var settled = false;
      var t = setTimeout(function () {
        if (settled) return;
        settled = true;
        reject(timeoutFault(timeoutMs, cmd));
      }, timeoutMs);
      p.then(function (v) {
        if (settled) return;
        settled = true; clearTimeout(t); resolve(v);
      }, function (e) {
        if (settled) return;
        settled = true; clearTimeout(t); reject(normalize(e));
      });
    });
  }

  NS.fault = fault;
  NS.normalizeFault = normalize;
  NS.invoke = invoke;
})(window.__BOOT_NS);