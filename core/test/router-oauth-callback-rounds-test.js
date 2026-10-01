#!/usr/bin/env node
'use strict';


const path = require('node:path');
const http = require('node:http');
const ROOT = path.join(__dirname, '..');
const { freePort } = require(path.join(__dirname, '_ports'));
const { createOAuthOps } = require(path.join(ROOT, 'src', 'domains', 'router', 'ops', 'oauth.js'));

const results = [];
const check = (n, c, x) => {
  results.push(!!c);
  console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  <- ' + x : ''));
};

(async () => {
  await (async () => {
    const watchers = [];
    // 夹具形状 = 平台层唯一出口 openBrowser(url, {intent:'isolated-login', onExit}) 的返回：三档词汇在顶层、隔离产物在 evidence 里；造错形状等于绕过契约。
    const ops = createOAuthOps({
      ports: { allocate: async () => freePort(), unregister: () => {}, allocateMark: () => {} },
      openInBrowser: async (url, onClose) => {
        watchers.push(onClose);
        return {
          ok: true, confirmed: true, handedOff: false, reason: null, error: null, message: '已在隔离窗口打开', url,
          evidence: { via: 'isolated', isolated: true, watch: true, profile: '/tmp/oauth-b26b-profile', bin: '/usr/bin/chrome' },
        };
      },
    });
    const cred = (state, key) => ({ apiKey: key, userId: 'u-' + key, userName: 'n', keyName: 'k', state });
    const post = (port, body) => new Promise((resolve, reject) => {
      const rq = http.request({ host: '127.0.0.1', port, path: '/callback', method: 'POST', headers: { 'Content-Type': 'application/json' } },
        (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, body: b })); });
      rq.on('error', reject);
      rq.end(JSON.stringify(body));
    });

    const s1 = await ops.commandcodeLoginStart();
    check('O-a 第一轮登录轮启动成功，且成功档原样透传平台层三档（confirmed/message 取自夹具，isolated 取自 evidence，本层不自造）',
      s1.ok === true && !!s1.state
      && s1.confirmed === true && s1.handedOff === false && s1.message === '已在隔离窗口打开'
      && s1.isolated === true && s1.isolatedBasis === 'isolated', JSON.stringify(s1).slice(0, 160));
    const inflight = http.request({ host: '127.0.0.1', port: s1.port, path: '/callback', method: 'POST', headers: { 'Content-Type': 'application/json' } });
    inflight.on('error', () => {});
    inflight.write(JSON.stringify(cred(s1.state, 'K1')));
    await new Promise((r) => setTimeout(r, 30));
    const s2 = await ops.commandcodeLoginStart();
    inflight.end();
    const r1 = await new Promise((resolve, reject) => {
      inflight.on('response', (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, body: b })); });
      inflight.on('error', reject);
    });
    check('O-b 第二轮登录轮启动成功（前置），且旧轮在途迟到回调回 410',
      s2.ok === true && s2.state !== s1.state && r1.status === 410, JSON.stringify(r1));
    const w2p = ops.commandcodeLoginWait(4000);
    const ok2 = await post(s2.port, cred(s2.state, 'K2'));
    const w2 = await w2p;
    check('O-c 新轮仍以自身凭据正常决议',
      ok2.status === 200 && w2.ok === true && w2.apiKey === 'K2', JSON.stringify(w2).slice(0, 100));
    const s3 = await ops.commandcodeLoginStart();
    if (watchers[1]) watchers[1](); // 第二轮的浏览器监视在第三轮在期迟到触发
    const w3p = ops.commandcodeLoginWait(4000);
    await post(s3.port, cred(s3.state, 'K3'));
    const w3 = await w3p;
    check('O-d 第三轮启动成功，且旧轮浏览器监视迟到不误杀新轮',
      s3.ok === true && w3.ok === true && w3.apiKey === 'K3', JSON.stringify(w3).slice(0, 100));

    const opsF = createOAuthOps({
      ports: { allocate: async () => freePort(), unregister: () => {}, allocateMark: () => {} },
      openInBrowser: async () => ({
        ok: false, confirmed: false, handedOff: false, reason: 'no-launcher', error: '未探到可启动的浏览器',
        message: null, url: 'x', evidence: { diagnostics: { pick: 'none-found' } },
      }),
    });
    const f1 = await opsF.commandcodeLoginStart();
    const wf = await opsF.commandcodeLoginWait(200);
    check('O-e 失败档把 authUrl/reason/evidence 一起交出（error 只补文案不改地址字段），且当场拆轮：wait 报「未在登录中」而非悬挂等待',
      f1.ok === false && f1.reason === 'no-launcher' && f1.url === f1.authUrl
      && !!f1.evidence && /手动打开/.test(f1.error)
      && wf.ok === false && /未在登录中/.test(wf.error), JSON.stringify([f1, wf]).slice(0, 200));
  })().catch((e) => check('O-f 异步块无异常完成（含网络夹具）', false, e && e.message));

  const failed = results.filter((r) => !r);
  console.log('\n结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
  process.exit(failed.length ? 1 : 0);
})();
