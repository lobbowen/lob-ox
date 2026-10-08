'use strict';


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

  // 审计 RL-2：relay 现强制 LAN 令牌（空令牌不再开放转发）。场景1/2 改为先以 ?token=lan-secret 换派生 cookie，
  // 再凭该 cookie 访问——DSH（管家）cookie 仍由上游/桥在通过 LAN 闸后注入。
  const relay = createRelay('127.0.0.1', targetPort, { token: 'lan-secret', dshToken: LAUNCH });
  await listen(relay);
  const relayPort = relay.address().port;

  const handShake = await req(relayPort, 'GET', '/?token=lan-secret');
  const sc = String((handShake.headers['set-cookie'] || []).join(';'));
  check('场景1: 无 LAN 令牌 → 先被闸重定向换 cookie（非直接 200）', handShake.code === 302 && /^lobox_lan_token=[0-9a-f]{64}(;|$)/.test(sc) && !sc.includes('lan-secret'), handShake.code + ' ' + sc);
  const lanCk1 = 'lobox_lan_token=' + ((/lobox_lan_token=([^;]+)/.exec(sc) || [])[1] || '');

  const r1 = await req(relayPort, 'GET', '/', { Cookie: lanCk1 });
  check('场景1: 凭 LAN 派生 cookie 经 relay 返回 200（DSH cookie 已注入）', r1.code === 200, r1.code + ' ' + r1.body);
  const r2 = await req(relayPort, 'GET', '/api/session/list', { Cookie: lanCk1 });
  check('场景1: /api 路径同样放行（非 401）', r2.code === 200, String(r2.code));

  const r3 = await req(relayPort, 'GET', '/', { Cookie: lanCk1 + '; dsh-auth-mock=abcdef123' });
  check('场景2: 客户端自带 DSH cookie（叠加 LAN cookie）仍 200', r3.code === 200, String(r3.code));

  const relay2 = createRelay('127.0.0.1', targetPort, { token: 'lan-secret', dshToken: LAUNCH });
  await listen(relay2);
  const p2 = relay2.address().port;

  const noToken = await req(p2, 'GET', '/');
  check('场景3: 无 LAN 令牌 → 401', noToken.code === 401, String(noToken.code));
  const withToken = await req(p2, 'GET', '/?token=lan-secret');
  const sc2 = String((withToken.headers['set-cookie'] || []).join(';'));
  check('场景3: 401/302 凭据响应均带 Cache-Control: no-store',
    String(noToken.headers['cache-control'] || '') === 'no-store' && String(withToken.headers['cache-control'] || '') === 'no-store',
    JSON.stringify([noToken.headers['cache-control'], withToken.headers['cache-control']]));
  check('场景3: ?token=lan-secret → 302 且所种 cookie 为派生 64hex（不含令牌原文）',
    withToken.code === 302 && /^lobox_lan_token=[0-9a-f]{64}(;|$)/.test(sc2) && !sc2.includes('lan-secret'),
    withToken.code + ' ' + sc2);
  const lanCk = 'lobox_lan_token=' + ((/lobox_lan_token=([^;]+)/.exec(sc2) || [])[1] || '');
  const withCookie = await req(p2, 'GET', '/', { Cookie: lanCk });
  check('场景3: lan 派生 cookie + DSH 桥 → 200', withCookie.code === 200, withCookie.code + ' ' + withCookie.body);
  const rawAsCookie = await req(p2, 'GET', '/', { Cookie: 'lobox_lan_token=lan-secret' });
  check('场景3: 门卫令牌原文冒充 cookie → 401（原文只容 ?token= 一次性出示）', rawAsCookie.code === 401, String(rawAsCookie.code));

  const rf = await req(p2, 'GET', '/anything', { Cookie: lanCk, Origin: 'http://192.168.3.64:3088', Referer: 'http://192.168.3.64:3088/' });
  check('场景4: HTTP 转发透传状态与响应体、上游响应头透传',
    rf.code === 200 && rf.body === 'mock-dsh' && rf.headers['x-mark'] === 'up', rf.code + ' ' + rf.body + ' ' + rf.headers['x-mark']);
  await req(p2, 'GET', '/api/x?token=lan-secret&keep=1', { Cookie: lanCk });
  const forwarded = seenReqs.filter((x) => x.path.indexOf('/api/x') === 0).pop() || {};
  check('场景4: 上游收到的路径已剥离 token 参数（其余参数原样）', forwarded.path === '/api/x?keep=1', String(forwarded.path));
  // 上游必须看到「回环权威」而不是 LAN 客户端地址，否则 DSH 的 Origin 门禁会拒掉转发请求。
  const fwd = seenReqs.filter((x) => x.path === '/anything').pop() || {};
  check('场景4: Origin/Referer/Host 呈现为回环权威（三面同源）',
    fwd.origin === 'http://127.0.0.1:' + targetPort && String(fwd.referer || '').startsWith('http://127.0.0.1:' + targetPort + '/')
    && fwd.host === '127.0.0.1:' + targetPort, JSON.stringify(fwd));

  // 失败退避账本：成功放行须先清零，否则起点被上一条 401 污染；阈值 = 累计 10 次失败 ⇒ 前 10 次 401，第 11 次起 429，锁定期出示正确令牌也 429。
  const prePass = await req(p2, 'GET', '/', { Cookie: lanCk });
  check('场景3b: 成功放行清零失败账本（前置）', prePass.code === 200, String(prePass.code));
  const codes3 = [];
  for (let i = 0; i < 11; i++) codes3.push((await req(p2, 'GET', '/?token=bad' + i)).code);
  const locked = await req(p2, 'GET', '/?token=lan-secret');
  check('场景3b: 前 10 次不越阈、第 11 次 429、锁定期正确令牌亦 429 且带 Retry-After',
    codes3.slice(0, 10).every((c) => c === 401) && codes3[10] === 429
    && locked.code === 429 && !!locked.headers['retry-after'],
    codes3.join(',') + ' locked=' + locked.code + ' ra=' + JSON.stringify(locked.headers['retry-after']));

  const core = require(pathMod.join(ROOT, 'src', 'domains', 'relay', 'core.js'));

  console.log('== 场景5 projectRemoteView（访问视图唯一事实源）==');
  {
    const pv = (x) => core.projectRemoteView(x);
    const greenLan = { mode: 'lan', relayListening: true, tokenSet: true, cookieReady: true, lanAddress: '192.168.3.64', wanPort: 22001 };
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
    {
      const v = pv(Object.assign({}, greenLan, { serverAddr: '203.0.113.9', tokenSet: false }));
      check('视图: lan 就绪 → accessUrl 用局域网地址、缺令牌不降级（serverAddr 诱饵未被选中）',
        v.ready === true && v.accessUrl === 'http://192.168.3.64:22001/', JSON.stringify(v));
      const w = pv({ mode: 'wan', relayListening: true, tokenSet: true, cookieReady: true, frpcRunning: true, serverAddr: '203.0.113.9', lanAddress: '192.168.3.64', wanPort: 22001 });
      check('视图: wan 就绪 → accessUrl 用 frps 公网地址（扫码进公网口）',
        w.ready === true && w.accessUrl === 'http://203.0.113.9:22001/', JSON.stringify(w));
    }
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
    {
      const v = pv(Object.assign({}, greenLan, { wanPort: null }));
      const v2 = pv(Object.assign({}, greenLan, { lanAddress: '' }));
      check('视图: wanPort 缺席 / lanAddress 空 → accessUrl=null（宁缺不半截，就绪判定不受影响）',
        v.accessUrl === null && v2.accessUrl === null && v2.ready === true, JSON.stringify([v, v2]));
    }
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

  console.log('== 场景6b backoffGate（失败退避判定）==');
  {
    const locked = core.backoffGate({ failCount: 10, firstAt: 1000, now: 5000 });
    check('backoffGate: 达阈值窗口内 → 非 null 剩余窗口（0 < waitMs ≤ 锁时长）',
      locked.waitMs > 0 && locked.waitMs <= 60000, JSON.stringify(locked));
    const reset = core.backoffGate({ failCount: 10, firstAt: 1000, now: 61001 });
    check('backoffGate: 超窗重置 → null（可立即再试）', reset.waitMs === null, JSON.stringify(reset));
  }

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
    const v1 = core.lanGateCookieValue('tok12345678', 'salt-A');
    check('门卫 cookie: 换 salt 即换值（进程重启全员失效）',
      core.lanGateCookieValue('tok12345678', 'salt-B') !== v1, core.lanGateCookieValue('tok12345678', 'salt-B'));
    check('门卫 cookie: 换 token 即换值（门卫令牌轮换旧 cookie 立即失配）',
      core.lanGateCookieValue('tok87654321', 'salt-A') !== v1, core.lanGateCookieValue('tok87654321', 'salt-A'));
  }

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
