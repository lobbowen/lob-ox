'use strict';

// 域：守卫/设置 API（changelog / guard 版本 / autostart / settings / self-update / env / ports）。
const fs = require('node:fs');
const path = require('node:path');

function owns(pathname) {
  return pathname === '/changelog' || pathname.startsWith('/guard/') || pathname === '/autostart'
    || pathname.startsWith('/settings/') || pathname.startsWith('/self-update/')
    || pathname === '/env/dsh' || pathname === '/env/status' || pathname === '/env/node-lts'
    || pathname === '/env/open-url' || pathname === '/env/environment'
    || pathname === '/env/environment/last'
    || pathname === '/ports' || pathname === '/shutdown';
}

/** DSH 更新日志：仅 DeepSeek Harness 相关内容（NativeManager 版本信息），与管家无关；UI 位于「概览-版本与升级」区块。 */
function fetchDshChangelog(res, sup) {
  const v = (sup && sup.nativeManager) ? sup.nativeManager.versionInfo() : {};
  const inst = v.installed || '未安装';
  const latest = v.latest || '—';
  const upd = v.updateAvailable;
  const md = 'DeepSeek Harness（DSH）更新日志\n\n'
    + '当前安装：' + inst + '\n'
    + '最新版本：' + latest + '\n'
    + (upd ? ('检测到新版本，可在「概览 · 版本与升级」一键升级到 ' + latest + '。\n') : '当前已是最新版本。\n')
    + '\n完整变更记录见 DeepSeek Harness GitHub Releases：\n'
    + 'https://github.com/deepseek-ai/DeepSeek-Harness/releases\n';
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  return res.end(md);
}

function handle(ctx) {
  const { sup, req, res, pathname, identity, send, collectBody, originAllowed, browser, environment } = ctx;
    if (req.method === 'GET' && pathname === '/changelog') {
      return fetchDshChangelog(res, sup);
    }
    // 管家自身更新日志（本地仓库 CHANGELOG.md）
    if (req.method === 'GET' && pathname === '/guard/changelog') {
      try {
        const md = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'CHANGELOG.md'), 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end(md);
      } catch {
        return send(404, { error: 'changelog not found' });
      }
    }
    // 管家自身版本（设置页展示）：GET=本地视图（无网络 I/O；git 探测异步执行不冻结事件循环）；
    //   POST=完整检查（异步 fetch）。
    if (req.method === 'GET' && pathname === '/guard/version') {
      return Promise.resolve(sup.guardVersionLocal()).then((r) => send(200, r)).catch((e) => send(500, { ok: false, error: e.message }));
    }
    if (req.method === 'POST' && pathname === '/guard/version/check') {
      req.resume();
      if (!originAllowed(req, sup.config.apiPort)) return send(403, { ok: false, error: 'cross-origin request rejected' });
      return sup.guardVersionCheck().then((r) => send(200, r)).catch((e) => send(500, { ok: false, error: e.message }));
    }

    // 开机自启（整条服务链：systemd + linger + GUI）
    if (req.method === 'GET' && pathname === '/autostart') {
      return send(200, sup.autostartStatus());
    }
    if (req.method === 'POST' && pathname === '/autostart') {
      if (!originAllowed(req, sup.config.apiPort)) {
        req.resume();
        return send(403, { ok: false, error: 'cross-origin request rejected' });
      }
      collectBody(req, res, 1024, (body) => {
        let enabled = null;
        try {
          const j = body ? JSON.parse(body) : {};
          if (typeof j.enabled === 'boolean') enabled = j.enabled;
        } catch {}
        if (enabled === null) return send(400, { ok: false, error: '需要 {"enabled":true|false}' });
        const r = sup.setAutostart(enabled);
        return send(r.ok ? 200 : 500, r);
      });
      return;
    }

    // 管家面板局域网访问开关（0.0.0.0 <-> 127.0.0.1）
    if (req.method === 'GET' && pathname === '/settings/lan') {
      return send(200, sup.lanPanelStatus());
    }
    if (req.method === 'POST' && pathname === '/settings/lan') {
      if (!originAllowed(req, sup.config.apiPort)) {
        req.resume();
        return send(403, { ok: false, error: 'cross-origin request rejected' });
      }
      collectBody(req, res, 1024, (body) => {
        let enabled = null;
        try { const j = body ? JSON.parse(body) : {}; if (typeof j.enabled === 'boolean') enabled = j.enabled; } catch {}
        if (enabled === null) return send(400, { ok: false, error: '需要 {"enabled":true|false}' });
        const r = sup.setLanPanel(enabled);
        // 未设访问密钥属客户端可修正的前置条件失败 -> 400；内部异常仍 500。
        return send(r.ok === false ? (r.code === 'ACCESS_KEY_REQUIRED' ? 400 : 500) : 200, r);
      });
      return;
    }
    // 出回环访问密钥：状态查询 / 设置/清除（空 key=清除）。不回显明文。
    if (req.method === 'GET' && pathname === '/settings/access-key') {
      return send(200, sup.accessKeyStatus());
    }
    if (req.method === 'POST' && pathname === '/settings/access-key') {
      if (!originAllowed(req, sup.config.apiPort)) {
        req.resume();
        return send(403, { ok: false, error: 'cross-origin request rejected' });
      }
      collectBody(req, res, 4096, (body) => {
        let key = null;
        try { const j = body ? JSON.parse(body) : {}; if (typeof j.key === 'string') key = j.key; } catch {}
        if (key === null) return send(400, { ok: false, error: '需要 {"key":"<访问密钥>"}（空串清除）' });
        if (key && key.length < 8) return send(400, { ok: false, error: '访问密钥至少 8 位（建议 16+ 位随机串）' });
        const r = sup.setAccessKey(key);
        return send(r.ok ? 200 : 500, r);
      });
      return;
    }
    // 关闭窗口行为（壳读取执行）：GET=当前值；POST=设置 'hide' | 'exit'
    if (req.method === 'GET' && pathname === '/settings/close-action') {
      return send(200, sup.closeActionStatus());
    }
    if (req.method === 'POST' && pathname === '/settings/close-action') {
      if (!originAllowed(req, sup.config.apiPort)) { req.resume(); return send(403, {}); }
      collectBody(req, res, 1024, (body) => {
        let v = null;
        try { const j = body ? JSON.parse(body) : {}; if (typeof j.closeAction === 'string') v = j.closeAction; } catch {}
        if (v === null) return send(400, { ok: false, error: '需要 {"closeAction":"hide"|"exit"}' });
        const r = sup.setCloseAction(v);
        return send(r.ok ? 200 : 500, r);
      });
      return;
    }
    // 外部打开的浏览器偏好：GET=当前值 + 候选清单；POST=设置 id（空串清除，回到按系统默认分发）。
    // 校验（id 必须是本机候选）在 settings/browser 门面，本域只是边界。
    if (req.method === 'GET' && pathname === '/settings/external-browser') {
      return send(200, sup.externalBrowserStatus());
    }
    if (req.method === 'POST' && pathname === '/settings/external-browser') {
      if (!originAllowed(req, sup.config.apiPort)) { req.resume(); return send(403, {}); }
      collectBody(req, res, 2048, (body) => {
        let id = null; let given = false;
        try { const j = body ? JSON.parse(body) : {}; if (typeof j.id === 'string') { id = j.id; given = true; } } catch {}
        if (!given) return send(400, { ok: false, error: '需要 {"id":"<候选 id>"}（空串清除偏好）' });
        const r = sup.setExternalBrowser(id);
        return send(r.ok ? 200 : 500, r);
      });
      return;
    }
    // 退出管家（壳「退出管家」/托盘调用）：停止全部服务链 + 守卫自身退出
    if (req.method === 'POST' && pathname === '/shutdown') {
      if (!originAllowed(req, sup.config.apiPort)) { req.resume(); return send(403, {}); }
      req.resume();
      Promise.resolve(sup.shutdownAll()).then((r) => { try { send(r.ok === false ? 400 : 200, r || { ok: true }); } catch {} }).catch(() => {});
      return;
    }

    // 内核更新单写入者 = 壳：本域只保留只读状态查询；安装/重启守卫归壳，写端点已下架。
    //   下架用 410 Gone + 稳定错误码（而非 404），让旧客户端得到可诊断的迁移结论。
    if (req.method === 'GET' && pathname === '/self-update/status') {
      if (!originAllowed(req, sup.config.apiPort)) { req.resume(); return send(403, {}); }
      Promise.resolve(sup.guardSelfUpdateStatus()).then((r) => send(r.ok ? 200 : 400, r));
      return;
    }
    if (req.method === 'POST' && pathname === '/self-update/apply') {
      req.resume();
      return send(410, {
        ok: false,
        code: 'KERNEL_UPDATE_SINGLE_WRITER',
        owner: 'desktop-shell',
        error: '内核更新由桌面壳执行（单写入者契约）：请在桌面壳的面板中点「更新」，或升级/重装桌面壳。',
      });
    }
    if (req.method === 'POST' && pathname === '/self-update/restart-guard') {
      req.resume();
      return send(410, {
        ok: false,
        code: 'KERNEL_UPDATE_SINGLE_WRITER',
        owner: 'desktop-shell',
        error: '守卫重启由桌面壳经服务管理器执行（守卫从不重启自己）：更新内核请用桌面壳。',
      });
    }

    if (req.method === 'GET' && pathname === '/env/dsh') {
      if (!originAllowed(req, sup.config.apiPort)) { req.resume(); return send(403, {}); }
      return send(200, sup.dshenvStatus());
    }
    if (req.method === 'GET' && pathname === '/env/status') {
      if (!originAllowed(req, sup.config.apiPort)) { req.resume(); return send(403, {}); }
      return Promise.resolve(sup.envStatus()).then((r) => send(200, r)).catch((e) => send(500, { ok: false, error: e.message }));
    }
    if (req.method === 'GET' && pathname === '/env/node-lts') {
      // Node LTS 本地判定（偶数主版本~LTS；6h 缓存，无远端查询，见 supervisor.nodeLtsStatus）
      return sup.nodeLtsStatus().then((r) => send(200, r)).catch((e) => send(500, { ok: false, error: e.message }));
    }
    // 环境表单（外部打开链路的底座，只读）：本机装了哪些浏览器、系统说不出默认时的候选次序、
    //   有没有图形会话、用户选过谁、运行时与出网条件、每条结论来自哪条系统事实。面板的「环境」区块
    //   与打开失败的定档依据同源取 here —— 真机报障时这一份就是证据，不必回内核机器读注册表。
    // ?force=1 = 人主动刷新：走异步 refresh 把维度台账里到期的探针补齐（含出网条件与运行时），
    //   并把这一拍落进快照；常态轮询只读同步表单（台账最近一拍），读路径绝不起子进程、绝不写盘。
    if (req.method === 'GET' && pathname === '/env/environment') {
      if (!originAllowed(req, sup.config.apiPort)) { req.resume(); return send(403, { ok: false, error: 'cross-origin request rejected' }); }
      const force = /[?&]force=1/.test(String(req.url || ''));
      return Promise.resolve(force ? environment.refresh({ persist: true, force: true }) : environment.form())
        .then((r) => send(200, r))
        .catch((e) => send(500, { ok: false, error: '环境表单装配失败：' + ((e && e.message) || e) }));
    }
    // 上一拍快照（只读留痕，零摸网零写盘）：分发判定永远走当场装配的 form()，本端点不参与任何判定。
    //   它补的是「快照落了盘却没人读」那一半：进程重启、探针失灵之后，这一台机器上一拍探到了什么
    //   仍然要读得回来，否则排障只剩守着日志等复现。available=false 分得清没写过与读不出。
    if (req.method === 'GET' && pathname === '/env/environment/last') {
      if (!originAllowed(req, sup.config.apiPort)) { req.resume(); return send(403, { ok: false, error: 'cross-origin request rejected' }); }
      return send(200, environment.lastSnapshot());
    }
    // 面板请内核把地址交给**内核所在机器**的系统浏览器（桌面壳的 webview 丢弃 window.open 与
    //   target=_blank，壳内面板唯一可行的代开方就是同机的内核）。三档结果原样回传，本域不解释结局；
    //   出口由网关经 ctx 交来（唯一实现处是 platform/os/browser），本域只是边界。
    // 回环限定：远程访问者的浏览器不在这台机器上，让它驱动本机弹窗既无用（open-web 的一次性码地址
    //   本就只在回环可达）又白送一个「在服务器上开浏览器」的动作面；面板据同一判据改走自己的 window.open。
    if (req.method === 'POST' && pathname === '/env/open-url') {
      if (!identity.loopback) { req.resume(); return send(403, { ok: false, error: '仅内核所在机器可请内核调起浏览器，请复制或自行打开该地址' }); }
      if (!originAllowed(req, sup.config.apiPort)) { req.resume(); return send(403, { ok: false, error: 'cross-origin request rejected' }); }
      collectBody(req, res, 4096, (body) => {
        let url = null;
        try { const j = body ? JSON.parse(body) : {}; if (typeof j.url === 'string') url = j.url; } catch {}
        if (!url) return send(400, { ok: false, error: '需要 {"url":"http(s)://…"}' });
        // 地址恒随结果交出（含抛错路径）：拿不到地址的失败只剩「再点一次」，用户无路可走。
        // logger 交进唯一出口：这一次打开的 argv 与档位落在守卫日志里，报障时不必再靠屏幕拍照。
        return Promise.resolve(browser.openBrowser(url, { logger: sup.logger }))
          .then((r) => send(r.ok ? 200 : 500, r))
          .catch((e) => send(500, { ok: false, reason: 'spawn-failed', error: '打开浏览器失败：' + ((e && e.message) || e), url }));
      });
      return;
    }

    // 统一端口管理清单（全系统端口登记：固定/实例/分配，含 owner 对应关系 + 激活探测）——经 sup 门面取数
    if (req.method === 'GET' && pathname === '/ports') {
      return Promise.resolve(sup.listPorts()).then((r) => send(200, r)).catch((e) => send(500, { error: e && e.message }));
    }
  // 域内未匹配(方法/子路径)：全局兜底语义
  if (req.method === 'GET' || req.method === 'POST') return send(404, { error: 'not found', path: pathname });
  return send(405, { error: 'method not allowed' });
}

module.exports = { owns, handle };
