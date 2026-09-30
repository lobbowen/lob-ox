'use strict';

// 执行边界的单一事实源：形态/路径类判定与启动期复校共用 exec-path 的同一纯函数。
const execPath = require('../../platform/os/exec-path');

// 域：实例管理 API（沙箱实例 CRUD/启停/open-web/版本更新）。
const crypto = require('node:crypto');
// 换取 dsh-auth 是令牌组件的职责，不走 token/index.js 门面：门面导出会扩大冻结 API 面。
const { bootstrapDshCookie } = require('../../platform/service/token/exchange');

// open-web 一次性授权码表（键=码，值={ id, exp }，仅内存）。DSH 令牌绝不进 URL：URL 原样进
// spawn argv，同机任意进程 ps 即可读到会话令牌（TK-G6）。浏览器只拿限时单次码回 /open 换 cookie。
const OPEN_WEB_CODES = new Map();
const OPEN_WEB_CODE_TTL_MS = 30000;

function issueOpenWebCode(id) {
  const code = crypto.randomUUID();
  OPEN_WEB_CODES.set(code, { id, exp: Date.now() + OPEN_WEB_CODE_TTL_MS });
  return code;
}

/** 校验并一次性消费授权码，返回 { id }；不存在/已过期返回 null。 */
function consumeOpenWebCode(code) {
  if (!code) return null;
  const rec = OPEN_WEB_CODES.get(code);
  if (!rec) return null;
  OPEN_WEB_CODES.delete(code); // 一次性：无论后续成败，先删
  if (!(rec.exp > Date.now())) return null;
  return { id: rec.id };
}

/** 撤销授权码（换取失败/异常时调用），避免留下可用凭证。 */
function dropOpenWebCode(code) { if (code) OPEN_WEB_CODES.delete(code); }

function owns(pathname) {
  return pathname === '/open' || pathname === '/instances' || pathname.startsWith('/instances/');
}

// GET /open?code=<一次性码>：消费码取实例 id，用 tokOf 的令牌向该实例回环 DSH 换 dsh-auth-* cookie，
// 303 到 DSH 端口根路径；令牌全程不出本进程。无 code 返 404，无效/过期码返 400。
function handleOpen(ctx) {
  const { sup, req, res, identity, originAllowed, tokOf } = ctx;
  // 从 req.url 自行解析：网关构造的 ctx 不含 url 键，取 ctx.url 恒为 undefined。
  const url = new URL(req.url, 'http://localhost');
  // 回跳目标只由实例真实端口与固定回环主机生成，绝不取自请求参数。
  const apiPort = sup.config.apiPort;
  const code = url.searchParams.get('code');
  const deny = (status, msg) => { res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end(msg); };
  // 授权码是回环本机凭证：只允许本机来源，写语义请求须过既有 CSRF 深化闸。
  if (!identity.loopback) return deny(403, '仅允许本机访问');
  if (!originAllowed(req, apiPort)) return deny(403, 'origin not allowed');
  const rec = consumeOpenWebCode(code);
  if (!rec) return deny(code ? 400 : 404, code ? '授权码无效或已过期' : '缺少授权码');
  // 实例解析与 GET /instances 的 decorate 同源：main 走守卫核心视图，沙箱走实例列表。
  const it = (rec.id === 'main' && sup.dshMainView && typeof sup.dshMainView === 'function')
    ? sup.dshMainView()
    : ((sup.instances.list() || []).find((x) => x.id === rec.id) || null);
  if (!it) return deny(404, '实例不存在');
  const tok = tokOf(rec.id);
  if (!tok) return deny(400, '实例令牌不可用');
  return bootstrapDshCookie('127.0.0.1', it.port, tok).then((cookie) => {
    if (!cookie) return deny(400, '令牌换取失败');
    res.writeHead(303, {
      // 跨端口共享 cookie 是设计意图（回环同源，端口不参与 site 判定），故须 Strict 杜绝跨站携带。
      'Set-Cookie': cookie + '; Path=/; HttpOnly; SameSite=Strict',
      'Location': 'http://127.0.0.1:' + it.port + '/',
    });
    res.end();
  }).catch((e) => { dropOpenWebCode(code); deny(500, (e && e.message) || 'open failed'); });
}

// command 原样经 startTransient 交给 systemd-run，任意二进制即「以守卫身份执行任意命令」，故本闸 fail-closed = 结构校验 + 入口白名单，路径存在性不作为放行依据。
// 允许两形态：A [node, <绝对路径的 DSH 入口>, ...参数]（相对入口按沙箱可写的 data 目录解析，故必须绝对）；B [<DSH 入口>, ...参数]；
// command 缺失/[] = 沙箱默认命令（域内 effectiveCommand 生成），不经本闸；非法一律 400 { ok:false, error }。
// 已知残留：basename 判据可被「把脚本命名为 dsh*.js」绕过，由执行前 realpath 归属复校兜底（domains/instance/lifecycle.js 共用 exec-path.commandEntryViolation）。
function commandShapeError(command, dshBin) {
  if (command === undefined || command === null) return null;
  if (!Array.isArray(command)) return 'command 必须为参数数组';
  if (!command.length) return null; // 空数组 = 用沙箱默认命令
  if (command.length > 64) return 'command 参数过多（上限 64）';
  for (const a of command) {
    if (typeof a !== 'string') return 'command 每项必须为字符串';
    if (!a.length) return 'command 不允许空参数';
    if (a.length > 4096) return 'command 单个参数过长（上限 4096）';
    if (/[\0\r\n]/.test(a)) return 'command 含非法字符（NUL/换行）';
  }
  // 白名单：只认 node / dsh 系列（大小写不敏感以兼容 Windows；两种分隔符都切，不依赖宿主平台）。
  const NODE_HEAD = new Set(['node', 'node.exe']);
  // command[0] 的 dsh 族维持现行为（含 Windows 的 dsh.exe / npm 垫片 dsh.cmd/.ps1）。
  const DSH_HEAD = new Set(['dsh', 'dsh.exe', 'dsh.js', 'dsh-supervisor', 'dsh-supervisor.js', 'dsh.cmd', 'dsh.ps1']);
  // command[1] 是 node 的脚本参数（.js 等），故不收 .exe/.cmd 形态。
  const DSH_ENTRY = new Set(['dsh', 'dsh.js', 'dsh-supervisor', 'dsh-supervisor.js']);
  const baseOf = (p) => String(p).split(/[\\/]/).pop().toLowerCase();
  const normPath = (p) => String(p).replace(/\\/g, '/');
  // 绝对路径：POSIX /…、Windows 盘符 X:\…、UNC \\…（形态 A 的硬要求）。
  const isAbsolute = (p) => /^(?:[A-Za-z]:[\\/]|[\\/])/.test(String(p));
  // 官方包内入口 <前缀>/node_modules/@deepseek-ai/dsh/lib/bin.js：取出前缀后用 exec-path.dshJsIn
  // 重拼并逐字比对，避免在此硬编码内核解析器的路径形态；不放行则内核自己的规范入口被本闸拒绝。
  const PKG_TAIL = '/node_modules/@deepseek-ai/dsh/lib/bin.js';
  const isDshPackageEntry = (p) => {
    if (baseOf(p) !== 'bin.js') return false;
    const n = normPath(p);
    if (n.length <= PKG_TAIL.length || n.slice(-PKG_TAIL.length) !== PKG_TAIL) return false;
    const prefix = n.slice(0, -PKG_TAIL.length);
    try { return normPath(execPath.dshJsIn(prefix)) === n; } catch { return false; }
  };
  // 配置的 DSH 可执行名（严格相等）；但不接受把 node 自己当 DSH 入口，否则 [node, node] 会通过。
  const isConfiguredDshBin = (p) => typeof dshBin === 'string' && dshBin !== '' && p === dshBin
    && !NODE_HEAD.has(baseOf(dshBin));
  const FORMS = '可用 [node, <绝对路径的 DSH 入口>, ...参数] 或 [<DSH 入口>, ...参数]';
  // 判定复用执行边界的同一纯函数（与执行前复校同规）：requireAbsoluteEntry 保形态 A 的绝对路径
  // 硬要求，allowEntry 保留包形态/basename/dshBin 白名单，files 追加内核解析出的已知入口。
  const sharedErr = execPath.commandEntryViolation(command, {
    requireAbsoluteEntry: true,
    files: execPath.knownDshEntries({ dshBin }),
    allowEntry: (entry) => isDshPackageEntry(entry) || DSH_ENTRY.has(baseOf(entry)) || isConfiguredDshBin(entry),
  });
  if (!sharedErr) return null;
  if (NODE_HEAD.has(baseOf(command[0]))) {
    const entry = command.length > 1 ? command[1] : '';
    if (!entry || !isAbsolute(entry)) {
      return 'command[0] 为 node 时，command[1] 必须是**绝对路径**的 DSH 入口（相对路径按沙箱 data 目录解析，已禁止）；' + FORMS;
    }
    return 'command[0] 为 node 时 command[1] 必须是 DSH 入口（dsh / dsh.js / dsh-supervisor / dsh-supervisor.js，'
      + '或 <前缀>/node_modules/@deepseek-ai/dsh/lib/bin.js）；' + FORMS;
  }
  // 形态 B：入口自身即 DSH；带分隔符的相对路径按沙箱可写工作目录解析，由共享判据拒绝。
  return sharedErr + '；' + FORMS + '；需要其它可执行请走插件安装通道';
}

function handle(ctx) {
  const { sup, req, res, pathname, identity, send, collectBody, originAllowed, tokOf, browser } = ctx;
  // logger 交进唯一出口：这次打开的 argv 与档位要能在守卫日志里查到（面板上的三档读数只有当场看得见的份）。
  function openInSystemBrowser(url) { return browser.openBrowser(url, { logger: sup.logger }); }

    // /open 落地页不属 /instances 前缀，但消费本域签发的一次性码、与 tokOf 同源，故不再建第二份实现。
    if (req.method === 'GET' && pathname === '/open') return handleOpen(ctx);

    if (req.method === 'GET' && pathname === '/instances') {
      // authUrl 只在回环来源附带 DSH 会话 token，token 一律按实例从唯一令牌节点取（原生/沙箱同源）。
      // 概念清分：instances[] = 沙箱实例（CRUD/启停/升级）；native = main 的只读条目，供横切视图取
      // 端口/开关，其生命周期与升级走 /lifecycle/dsh/* 与 /native/*，不落在本 API。
      const decorate = (it) => {
        const tok = tokOf(it.id);
        const out = Object.assign({}, it);
        // 远程控制令牌的边界：默认剔除，只留 tokenSet 布尔（main 视图含 remoteToken 供 LanManager
        // mainOf 进程内消费，沙箱记录同字段）。回环来源例外交出明文：本机面板要能查看/修改已分配的
        // 令牌，才能把「开启远程控制时自动补齐的凭据」闭环——判据与下方 authUrl 同一条（identity.loopback，
        // socket 层现取）。LAN/公网访客仍只见布尔，放宽的是呈现形态而非可达面。
        const loopback = identity.loopback;
        out.tokenSet = !!String(it.remoteToken || '').trim();
        if (!loopback) delete out.remoteToken;
        out.authUrl = (tok && loopback)
          ? ('http://127.0.0.1:' + it.port + '/?token=' + encodeURIComponent(tok))
          : ('http://127.0.0.1:' + it.port + '/');
        out.tokenPresent = loopback && !!tok;
        // 远程可用性/访问 URL 单一来源是 /lan-access 的 remote 视图，本列表只携带原始字段。
        return out;
      };
      const render = () => {
        const sandboxes = (sup.instances.list() || []).filter((i) => i.domain === 'sandbox');
        const main = (sup.dshMainView && typeof sup.dshMainView === 'function') ? sup.dshMainView() : null;
        return send(200, {
          instances: sandboxes.map((it) => decorate(it)),
          native: main ? decorate(main) : null,
        });
      };
      return render();
    }
    if (req.method === 'POST' && pathname.startsWith('/instances/')) {
      if (!originAllowed(req, sup.config.apiPort)) { req.resume(); return send(403, {}); }
      const act = pathname.slice('/instances/'.length);
      collectBody(req, res, 65536, (body) => {
        try {
          const j = body ? JSON.parse(body) : {};
          if (act === 'add') {
            const cmdErr = commandShapeError(j.command, sup.instances && sup.instances.dshBin);
            if (cmdErr) return send(400, { ok: false, error: cmdErr });
            // addInstance 是 async（含端口占用探测），必须等结果作答：send 收到 Promise 会让 r.ok 恒 undefined。
            return Promise.resolve(sup.instances.addInstance(j))
              .then((r) => send(r && r.ok ? 200 : 400, r))
              .catch((e) => send(500, { ok: false, error: (e && e.message) || String(e) }));
          }
          // 护栏：落到 main 的管理动作一律拒绝，避免守卫 spawn 与 systemd-run 沙箱两套语义并存。
          if (j.id) {
            const target = sup.instances.find(j.id);
            if (target && target.domain === 'native' && act !== 'open-web') {
              const hint = (act === 'start' || act === 'stop' || act === 'restart')
                ? '原生主实例请经 /lifecycle/dsh/start|stop 启停'
                : '原生主实例请经 /native/* 管理（安装/升级/卸载/版本检测）';
              return send(400, { ok: false, error: hint });
            }
          }
          // 域动作的 {ok:false} 一律映射为非 2xx：恒 200 会让面板显示「已删除/已停止/已启动」而实际未生效。
          if (act === 'remove' && j.id) { const r = sup.instances.removeInstance(j.id); return send(r && r.ok ? 200 : 400, r); }
          if (act === 'update' && j.id) { const r = sup.instances.updateInstance(j.id, j); return send(r && r.ok ? 200 : 400, r); }
          // 面板「启动/重试」= 用户显式动作：opts.manual 开新失败链（B2-6d，退避计数清零归监督拍累加）。
          if (act === 'start' && j.id) return Promise.resolve(sup.instances.startInstance(j.id, { manual: true }))
            .then((r) => send(r && r.ok ? 200 : 400, r))
            .catch((e) => send(500, { ok: false, error: e.message }));
          if (act === 'stop' && j.id) { const r = sup.instances.stopInstance(j.id); return send(r && r.ok ? 200 : 400, r); }
          // 用系统默认浏览器打开实例 Web（Tauri/WebView 内 window.open 被拦）。
          // TK-G6：URL 只带一次性授权码，令牌本身不得进 spawn argv。
          if (act === 'open-web' && j.id) {
            try {
              const it = (j.id === 'main' && sup.dshMainView && typeof sup.dshMainView === 'function')
                ? sup.dshMainView()
                : ((sup.instances.list() || []).find((x) => x.id === j.id) || null);
              if (!it) return send(404, { ok: false, error: '实例不存在' });
              // 只跳该实例的真实回环端口，防开放重定向
              if (!(Number(it.port) > 0)) return send(400, { ok: false, error: '非法端口' });
              const code = issueOpenWebCode(j.id);
              const url = 'http://127.0.0.1:' + sup.config.apiPort + '/open?code=' + code;
              // 三档结果（confirmed / handedOff / ok:false）原样透传：面板据此区分「已在浏览器打开」
              // 与「只是把地址交了出去」，并把 url 呈现为可复制文本 —— 旧实现把 spawn 未抛错当成功，
              // 屏幕上什么都没有却显示成功。
              return Promise.resolve(openInSystemBrowser(url)).then((r) => {
                if (!r.ok) dropOpenWebCode(code);
                return send(r.ok ? 200 : 500, r);
              }).catch((e) => {
                dropOpenWebCode(code);
                return send(500, { ok: false, reason: 'spawn-failed', error: '打开浏览器失败：' + ((e && e.message) || e), url });
              });
            } catch (e) { return send(500, { ok: false, error: e.message }); }
          }
          // 沙箱实例版本更新：检查 / 升级（job 模型，前端轮询 upgrade/status）
          if (act === 'check-update' && j.id) return Promise.resolve(sup.instances.checkUpdate(j.id)).then((r) => send(200, r)).catch((e) => send(500, { ok: false, error: e.message }));
          if (act === 'upgrade' && j.id) return Promise.resolve(sup.instances.upgradeInstance(j.id)).then((r) => send(200, r)).catch((e) => send(500, { ok: false, error: e.message }));
          if (act === 'upgrade/status' && j.id) return send(200, sup.instances.upgradeStatus(j.id));
          return send(404, { error: 'not found' });
        } catch (e) { return send(500, { ok: false, error: e.message }); }
      });
      return;
    }
  // 域内未匹配(方法/子路径)：全局兜底语义(与单文件时代一致)
  if (req.method === 'GET' || req.method === 'POST') return send(404, { error: 'not found', path: pathname });
  return send(405, { error: 'method not allowed' });
}

// handleOpen 一并导出：源码正则证明不了「令牌不进 URL」，须能真实驱动 /open 并看 Set-Cookie。
module.exports = { owns, handle, handleOpen, issueOpenWebCode, consumeOpenWebCode };
