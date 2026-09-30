'use strict';

// 远程控制 relay（createRelay）行为测试 —— 单一归属文件：
//   场景 1/2：DSH 浏览器会话桥。新版 DSH（0.1.2+）对根 URL 强制浏览器会话认证（401），
//             relay 需持 DSH 启动令牌向回环 DSH 换取签名 cookie（dsh-auth-*）并注入转发请求，
//             LAN 客户端才可访问；客户端自带同名 cookie 时不重复换取。
//   场景 3：LAN 门卫（?token= → 派生 cookie、原文不可当会话、失败退避）。
//   场景 4：转发面（状态/响应体/上游响应头透传；Origin/Referer/Host 呈现为回环权威）。
//
// 2026-10-12 瘦身（THIN-1-12）：
//   - 原「场景 3 门卫四连」是同一判据的**第三份拷贝**（另见 defects-batch-f-test.js 的单测），
//     此处合并成一份完整集成判据，并补齐原先只有 core-test 才有的三条独有保护：凭据响应
//     `Cache-Control: no-store`、门卫令牌不得随 path 泄进上游、同 IP 失败退避阶梯。
//   - 原「场景 4 setDshToken 热更新」名为覆盖实为**零断言**（对旧 relay 调用后无断言、随后又
//     新建 relay），已整段删除；该链路当前无覆盖。
//   - 原「HTML 注入 randomUUID polyfill」断言响应体出现字面串（改注入方式即红）属形态锁，已删。
//
// 2026-10-13 拆入（原 test/defects-batch-f-test.js 整文件解散）：
//   该文件是「缺陷批次 F」编号的产物，架构里没有任何对应物，且内部含 ≥12 条负价值断言
//   （同谓词枚举铺量、不可达入参自证、内部中文文案逐字锁、精确簿记常量、跨文件重复采样）。
//   按能力域拆入所有者文件后删除本文件。本文件是中继反代域（relay/core + router 反代读取面）的
//   所有者，故接收：projectRemoteView / upstreamPath / backoffGate / remoteTokenStrength /
//   lanGateCookieValue 轮换 / readUpstreamBody（后三者见场景 7/8）。
//   拆入时的取舍：内联中文 reason 不再逐字锁（只锁因的条数、顺序与关键因包含关系）；
//   accessUrl 精确串保留（它是**外部可观测**——二维码里就是这一串）。

const http = require('node:http');
const pathMod = require('node:path');
const ROOT = pathMod.join(__dirname, '..');
const { createRelay } = require(pathMod.join(__dirname, '..', 'src', 'domains', 'relay'));

let failures = 0;
function check(name, ok, extra) {
  if (ok) console.log('  PASS ' + name);
  else { failures++; console.log('  FAIL ' + name + (extra ? ' :: ' + extra : '')); }
}
function req(port, method, p, headers, body) {
  return new Promise((resolve) => {
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers, timeout: 5000 }, (res) => {
      let data = '';
      res.on('data', (d) => (data += d));
      res.on('end', () => resolve({ code: res.statusCode, body: data, headers: res.headers }));
    });
    r.on('error', (e) => resolve({ code: 0, body: e.message, headers: {} }));
    if (body) r.write(body);
    r.end();
  });
}
const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', r));

async function main() {
  const LAUNCH = 'launch-token-abc123';

  // -- mock 上游：模拟新版 DSH 的浏览器会话认证 + 记录每个请求的权威头与 path --
  // GET /?token=<launchToken> -> 303 + Set-Cookie: dsh-auth-xxx=<sig>
  // 其他路径：带 dsh-auth-xxx cookie -> 200；无 -> 401（"dsh web authentication required"）
  const seenReqs = [];
  const upstream = http.createServer((q, s) => {
    const url = new URL(q.url, 'http://127.0.0.1');
    seenReqs.push({ path: q.url, origin: q.headers.origin || null, referer: q.headers.referer || null, host: q.headers.host || null });
    if (url.pathname === '/' && url.searchParams.get('token') === LAUNCH) {
      s.writeHead(303, { location: '/', 'set-cookie': 'dsh-auth-mock=abcdef123; Path=/; HttpOnly; SameSite=Strict' });
      s.end();
      return;
    }
    const cookie = q.headers.cookie || '';
    if (!/dsh-auth-mock=abcdef123/.test(cookie)) {
      s.writeHead(401, { 'content-type': 'text/plain' });
      s.end('dsh web authentication required; reopen the URL printed by dsh web.');
      return;
    }
    s.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'x-mark': 'up' });
    s.end('mock-dsh');
  });
  await listen(upstream);
  const targetPort = upstream.address().port;

  // -- 场景 1：配置 dshToken -> relay 自动换取并注入 cookie，根 URL 200 --
  const relay = createRelay('127.0.0.1', targetPort, { dshToken: LAUNCH });
  await listen(relay);
  const relayPort = relay.address().port;

  const r1 = await req(relayPort, 'GET', '/');
  check('场景1: 根 URL 经 relay 返回 200（DSH cookie 已注入）', r1.code === 200, r1.code + ' ' + r1.body);
  const r2 = await req(relayPort, 'GET', '/api/session/list');
  check('场景1: /api 路径同样放行（非 401）', r2.code === 200, String(r2.code));

  // -- 场景 2：客户端自带同名 DSH cookie 时不重复注入 --
  const r3 = await req(relayPort, 'GET', '/', { Cookie: 'dsh-auth-mock=abcdef123' });
  check('场景2: 客户端自带 DSH cookie 仍 200', r3.code === 200, String(r3.code));

  // -- 场景 3/4：LAN 门卫与 DSH 桥并存（同一个 relay，门卫在最外层）--
  const relay2 = createRelay('127.0.0.1', targetPort, { token: 'lan-secret', dshToken: LAUNCH });
  await listen(relay2);
  const p2 = relay2.address().port;

  const noToken = await req(p2, 'GET', '/');
  check('场景3: 无 LAN 令牌 → 401', noToken.code === 401, String(noToken.code));
  const withToken = await req(p2, 'GET', '/?token=lan-secret');
  const sc2 = String((withToken.headers['set-cookie'] || []).join(';'));
  // 凭据响应不得被任何中间缓存保存：401（拒绝）与 302（种 cookie）两侧都要 no-store。
  check('场景3: 401/302 凭据响应均带 Cache-Control: no-store',
    String(noToken.headers['cache-control'] || '') === 'no-store' && String(withToken.headers['cache-control'] || '') === 'no-store',
    JSON.stringify([noToken.headers['cache-control'], withToken.headers['cache-control']]));
  // 种下的 cookie 必须是派生会话值：门卫令牌原文不再有任何会话通道。
  check('场景3: ?token=lan-secret → 302 且所种 cookie 为派生 64hex（不含令牌原文）',
    withToken.code === 302 && /^dsh_lan_token=[0-9a-f]{64}(;|$)/.test(sc2) && !sc2.includes('lan-secret'),
    withToken.code + ' ' + sc2);
  const lanCk = 'dsh_lan_token=' + ((/dsh_lan_token=([^;]+)/.exec(sc2) || [])[1] || '');
  const withCookie = await req(p2, 'GET', '/', { Cookie: lanCk });
  check('场景3: lan 派生 cookie + DSH 桥 → 200', withCookie.code === 200, withCookie.code + ' ' + withCookie.body);
  const rawAsCookie = await req(p2, 'GET', '/', { Cookie: 'dsh_lan_token=lan-secret' });
  check('场景3: 门卫令牌原文冒充 cookie → 401（原文只容 ?token= 一次性出示）', rawAsCookie.code === 401, String(rawAsCookie.code));

  // -- 场景 4：转发面（透传 + 回环权威）--
  const rf = await req(p2, 'GET', '/anything', { Cookie: lanCk, Origin: 'http://192.168.3.64:3088', Referer: 'http://192.168.3.64:3088/' });
  check('场景4: HTTP 转发透传状态与响应体、上游响应头透传',
    rf.code === 200 && rf.body === 'mock-dsh' && rf.headers['x-mark'] === 'up', rf.code + ' ' + rf.body + ' ' + rf.headers['x-mark']);
  // 门卫令牌不得随 path 泄进上游（DSH 访问日志）；其余查询参数原样保留。
  await req(p2, 'GET', '/api/x?token=lan-secret&keep=1', { Cookie: lanCk });
  const forwarded = seenReqs.filter((x) => x.path.indexOf('/api/x') === 0).pop() || {};
  check('场景4: 上游收到的路径已剥离 token 参数（其余参数原样）', forwarded.path === '/api/x?keep=1', String(forwarded.path));
  // 上游必须看到「回环权威」而不是 LAN 客户端的地址（否则 DSH 的 Origin 门禁会拒掉转发请求）。
  const fwd = seenReqs.filter((x) => x.path === '/anything').pop() || {};
  check('场景4: Origin/Referer/Host 呈现为回环权威（三面同源）',
    fwd.origin === 'http://127.0.0.1:' + targetPort && String(fwd.referer || '').startsWith('http://127.0.0.1:' + targetPort + '/')
    && fwd.host === '127.0.0.1:' + targetPort, JSON.stringify(fwd));

  // -- 场景 3b：同 IP 失败退避（HTTP 与 WS 共享账本）--
  //   成功放行必须先清零账本，否则起点被上一条 401 污染；阈值 = 累计 10 次失败，
  //   故前 10 次各回 401（未越阈），第 11 次起 429，且锁定期即使出示正确令牌也 429。
  const prePass = await req(p2, 'GET', '/', { Cookie: lanCk });
  check('场景3b: 成功放行清零失败账本（前置）', prePass.code === 200, String(prePass.code));
  const codes3 = [];
  for (let i = 0; i < 11; i++) codes3.push((await req(p2, 'GET', '/?token=bad' + i)).code);
  const locked = await req(p2, 'GET', '/?token=lan-secret');
  check('场景3b: 前 10 次不越阈、第 11 次 429、锁定期正确令牌亦 429 且带 Retry-After',
    codes3.slice(0, 10).every((c) => c === 401) && codes3[10] === 429
    && locked.code === 429 && !!locked.headers['retry-after'],
    codes3.join(',') + ' locked=' + locked.code + ' ra=' + JSON.stringify(locked.headers['retry-after']));

  // ==========================================================================
  // 场景 5–8：中继反代域纯函数面（原 test/defects-batch-f-test.js 按域拆入）
  // ==========================================================================
  const core = require(pathMod.join(ROOT, 'src', 'domains', 'relay', 'core.js'));

  // -- 场景 5：projectRemoteView —— 远程访问视图的唯一事实源 --
  //   off 短路、reasons 优先级、访问令牌只计入 wan、accessUrl 与 ready 正交、host 按 mode 选、
  //   端口缺席不拼半截 URL。判据只锁「因的条数/顺序 + 关键因包含关系」，不锁内部措辞。
  console.log('== 场景5 projectRemoteView（访问视图唯一事实源）==');
  {
    const pv = (x) => core.projectRemoteView(x);
    const greenLan = { mode: 'lan', relayListening: true, tokenSet: true, cookieReady: true, lanAddress: '192.168.3.64', wanPort: 22001 };
    // off 短路：即使运行时事实全部就绪也不出 URL/不报因（关 = 无访问态可言）
    {
      const v = pv(Object.assign({}, greenLan, { mode: 'off', serverAddr: '203.0.113.9', frpcRunning: true }));
      check('视图: off 短路 {ready:false, accessUrl:null, reasons:[]}',
        v.ready === false && v.accessUrl === null && v.reasons.length === 0, JSON.stringify(v));
    }
    {
      const v = pv({ mode: 'bogus', relayListening: true });
      check('视图: 非法/缺省 mode 归一为 off（normalizeRemoteMode 单一入口）',
        v.mode === 'off' && pv({}).mode === 'off', JSON.stringify(v));
    }
    // 未就绪逐条给因 + 优先级：relay 未监听 在 会话注入 之前（else-if 不重复报）
    {
      const v = pv({ mode: 'lan' });
      check('视图: lan 全缺 → 唯一因是 relay 未监听（缺令牌不计入 lan）',
        v.reasons.length === 1 && /relay/.test(v.reasons[0]), JSON.stringify(v));
    }
    {
      const v = pv({ mode: 'lan', relayListening: true, tokenSet: false, cookieReady: false });
      check('视图: lan 监听后会话未注入 → 只报注入一条（不叠加 relay 因）',
        v.reasons.length === 1 && /会话/.test(v.reasons[0]), JSON.stringify(v));
    }
    // host 选择 + 令牌不计入 lan：lan 用局域网地址、wan 用 serverAddr——另一个字段放诱饵值，选错即红；
    // 缺令牌对 lan 不构成访问不通（门卫空令牌恒放行），把它计入 = 明明能扫码却被判不可用。
    {
      const v = pv(Object.assign({}, greenLan, { serverAddr: '203.0.113.9', tokenSet: false }));
      check('视图: lan 就绪 → accessUrl 用局域网地址、缺令牌不降级（serverAddr 诱饵未被选中）',
        v.ready === true && v.accessUrl === 'http://192.168.3.64:22001/', JSON.stringify(v));
      const w = pv({ mode: 'wan', relayListening: true, tokenSet: true, cookieReady: true, frpcRunning: true, serverAddr: '203.0.113.9', lanAddress: '192.168.3.64', wanPort: 22001 });
      check('视图: wan 就绪 → accessUrl 用 frps 公网地址（扫码进公网口）',
        w.ready === true && w.accessUrl === 'http://203.0.113.9:22001/', JSON.stringify(w));
    }
    // 未就绪也要给出可复制地址；wan 附加两因可并存（各报一条，顺序 = 判定优先级）
    {
      const v = pv(Object.assign({}, greenLan, { relayListening: false }));
      check('视图: 未就绪（relay 未监听）仍出 accessUrl（地址与 ready 正交）',
        v.ready === false && v.accessUrl === 'http://192.168.3.64:22001/', JSON.stringify(v));
      const v2 = pv(Object.assign({}, greenLan, { mode: 'wan', serverAddr: '', frpcRunning: false }));
      check('视图: wan 未配地址+隧道未建 → 两条都报（不吞并列因）',
        v2.ready === false && v2.reasons.length === 2 && /地址/.test(v2.reasons[0]) && /隧道/.test(v2.reasons[1]),
        JSON.stringify(v2));
      const v3 = pv(Object.assign({}, greenLan, { mode: 'wan', serverAddr: '   ', frpcRunning: true }));
      check('视图: serverAddr 纯空白视同未配（trim 判定，防拼出 http:// :port/）',
        v3.reasons.length === 1 && /地址/.test(v3.reasons[0]) && v3.accessUrl === null, JSON.stringify(v3));
    }
    // 端口/地址缺席不拼半截 URL（同号纪律下 relay 口即公网口，缺位 = 还没绑定）
    {
      const v = pv(Object.assign({}, greenLan, { wanPort: null }));
      const v2 = pv(Object.assign({}, greenLan, { lanAddress: '' }));
      check('视图: wanPort 缺席 / lanAddress 空 → accessUrl=null（宁缺不半截，就绪判定不受影响）',
        v.accessUrl === null && v2.accessUrl === null && v2.ready === true, JSON.stringify([v, v2]));
    }
    // 反向防空转：ready 必须真依赖 reasons 全清（漏一条原因字段必被检出）。五个原因字段各翻一次。
    {
      const base = { mode: 'wan', relayListening: true, tokenSet: true, cookieReady: true, serverAddr: '203.0.113.9', frpcRunning: true, lanAddress: 'h', wanPort: 1 };
      const flips = [
        ['relayListening=false', Object.assign({}, base, { relayListening: false })],
        ['tokenSet=false', Object.assign({}, base, { tokenSet: false })],
        ['cookieReady=false', Object.assign({}, base, { cookieReady: false })],
        ['serverAddr=空', Object.assign({}, base, { serverAddr: '' })],
        ['frpcRunning=false', Object.assign({}, base, { frpcRunning: false })],
      ];
      const bad = flips.filter(([, f]) => !(pv(f).ready === false && pv(f).reasons.length >= 1)).map(([l]) => l);
      check('视图 反向: wan 全就绪基线本身为 ready，五个原因字段各翻一次即 ready=false',
        pv(base).ready === true && bad.length === 0, 'notFlipped=' + JSON.stringify(bad));
    }
  }

  // -- 场景 6：upstreamPath —— 门卫令牌不得随 path 泄进上游（HTTP 与 tunnel 共用本实现）--
  //   本文件的场景 4 已从**集成面**钉过同一条（真请求 → 上游收到的 path）；这里钉纯函数的边界用例。
  console.log('== 场景6 upstreamPath（门卫令牌不进上游）==');
  {
    const cases = [
      ['/x?a=1&token=abc', '/x?a=1'],
      ['/?token=', '/'],
      ['/keep?a=1&b=2', '/keep?a=1&b=2'],
    ];
    for (const [input, want] of cases) {
      const got = core.upstreamPath(input);
      check('upstreamPath: ' + input + ' → ' + want, got === want, got);
    }
  }

  // -- 场景 6b：backoffGate —— 门卫失败退避的纯判定（计时与账本在 proxy 层）--
  //   原件 5 例里有 3 例断言精确 waitMs（56000/60000）= 内部簿记常量精确值，已删：
  //   判据是「达阈值 → 非 null 的剩余窗口」与「超窗重置」，不是锁死 lockMs 的算法写法。
  console.log('== 场景6b backoffGate（失败退避判定）==');
  {
    const locked = core.backoffGate({ failCount: 10, firstAt: 1000, now: 5000 });
    check('backoffGate: 达阈值窗口内 → 非 null 剩余窗口（0 < waitMs ≤ 锁时长）',
      locked.waitMs > 0 && locked.waitMs <= 60000, JSON.stringify(locked));
    const reset = core.backoffGate({ failCount: 10, firstAt: 1000, now: 61001 });
    check('backoffGate: 超窗重置 → null（可立即再试）', reset.waitMs === null, JSON.stringify(reset));
  }

  // -- 场景 7：令牌强度闸与门卫 cookie 派生（shared/credential + relay/core）--
  //   remoteTokenStrength 被 relay/instance 两域 + app 编排层三处消费，wan 闸（validateWanAccess）
  //   即在本域 core.js。原件 8 例含 null/undefined/纯空格（**不可达入参自证**）已删 3 例；
  //   validateWanAccess 的 3 例与 remote-mode-wan-gate-test.js 的 W-c/W-f 同事实，整段删。
  console.log('== 场景7 令牌强度闸（wan 前置）与门卫 cookie 派生 ==');
  {
    const cred = require(pathMod.join(ROOT, 'src', 'shared', 'credential.js'));
    const strength = [
      ['empty-string', '', false],
      ['7 chars', '1234567', false],
      ['8 chars', '12345678', true],
      ['8 chars + pad', ' 12345678 ', true],
      ['long', 'a-very-remote-token-value-0123456789', true],
    ];
    for (const [label, input, wantOk] of strength) {
      const r = cred.remoteTokenStrength(input);
      check('令牌强度: ' + label + ' → ok=' + wantOk, r.ok === wantOk, JSON.stringify(r));
    }
    // 门卫 cookie 派生值：本文件场景 3 已从集成面钉了「?token= → 302 种派生 cookie / 原文冒充 → 401 /
    //   派生 cookie 放行」，此处只补集成面拿不到的**轮换**语义（换 salt / 换 token 即换值）。
    const v1 = core.lanGateCookieValue('tok12345678', 'salt-A');
    check('门卫 cookie: 换 salt 即换值（进程重启全员失效）',
      core.lanGateCookieValue('tok12345678', 'salt-B') !== v1, core.lanGateCookieValue('tok12345678', 'salt-B'));
    check('门卫 cookie: 换 token 即换值（门卫令牌轮换旧 cookie 立即失配）',
      core.lanGateCookieValue('tok87654321', 'salt-A') !== v1, core.lanGateCookieValue('tok87654321', 'salt-A'));
  }

  // -- 场景 8：readUpstreamBody —— 上游响应体的有界读取（router 反代面）--
  //   跨 chunk 多字节不损坏（Buffer 累积，不是 string 拼接）+ 尊重 maxBytes。
  console.log('== 场景8 readUpstreamBody（上游响应体有界读取）==');
  {
    const { readUpstreamBody } = require(pathMod.join(ROOT, 'src', 'domains', 'router', 'handlers', 'upstream-body.js'));
    const { Readable } = require('node:stream');
    const ub = Buffer.from('你好世界', 'utf8'); // 12 字节，在 5 字节处切断 → 半字符跨 chunk
    const t = await readUpstreamBody(Readable.from([ub.subarray(0, 5), ub.subarray(5)]), 65536, 2000);
    check('readUpstreamBody: 跨 chunk 多字节不损坏', t === '你好世界', JSON.stringify(t));
    const t2 = await readUpstreamBody(Readable.from([Buffer.from('0123456789')]), 4, 2000);
    check('readUpstreamBody: 尊重 maxBytes（累积不超界）',
      Buffer.byteLength(t2) <= 12 && t2.startsWith('0123'), JSON.stringify({ len: t2.length, v: t2 }));
  }

  await new Promise((r) => relay.close(r));
  await new Promise((r) => relay2.close(r));
  await new Promise((r) => upstream.close(r));

  console.log(failures === 0 ? '\nrelay-dshauth: ALL PASS' : '\nrelay-dshauth: ' + failures + ' FAILED');
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
