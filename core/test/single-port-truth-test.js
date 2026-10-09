'use strict';

// 架构回归（双源真相缺陷）：CORS/同源闸门必须以「本进程 http.Server 真实绑定端口」为唯一运行时真相，
// 而非冻结的 config.apiPort。bind 端口（listen 回调）与冻结配置可能不一致（端口顺延/陈旧），
// 壳侧 discovered_api_port 读 ports.json，而 bin/lobox 在 listen 回调里把同一绑定端口写入 ports.json
// ⇒ 内核（活端口）与壳（ports.json）天然一致；若闸门盲信 config.apiPort，则会 403 掉壳导航来的请求。
//
// 本测试：让 guard 以 CFG_PORT 监听，再把 config.apiPort 改指另一端口（模拟「冻结值 ≠ 真实绑定端口」），
// 断言：GET 闸控端点对「真实绑定端口的 Origin」放行、对「冻结 config.apiPort 的 Origin」拒 403。

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const ROOT = path.join(__dirname, '..');
const { Supervisor } = require(path.join(ROOT, 'src', 'supervisor'));

const MOCK = path.join(ROOT, 'test', 'mock-target.js');
const MOCK_PORT = 28831;
const CFG_PORT = 28820;       // 真实监听端口（也是冻结 config.apiPort 初始值）
const FROZEN_PORT = 28822;    // 把 config.apiPort 改成这个值，模拟「冻结值 ≠ 真实绑定端口」
const GATED = '/env/status';  // GET 受 originAllowed 闸控

let passed = 0, failed = 0;
function check(name, cond, extra = '') {
  if (cond) { passed++; console.log('  PASS ' + name); }
  else { failed++; console.log('  FAIL ' + name + (extra ? '  ← ' + extra : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function request(port, method, p, headers = {}) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers, timeout: 5000 }, (res) => {
      let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => resolve({ code: res.statusCode, body: b, headers: res.headers }));
    });
    req.on('error', (e) => resolve({ code: 0, body: '', error: e.message }));
    req.end();
  });
}

async function main() {
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'single-port-truth-'));
  const cfg = {
    command: ['node', MOCK, String(MOCK_PORT)], healthUrl: 'http://127.0.0.1:' + MOCK_PORT + '/',
    tickIntervalMs: 300, startsecs: 5, stopGraceMs: 600, portReleaseWaitMs: 500,
    startupFailWindowMs: 60000, startupFailBurst: 5,
    apiHost: '127.0.0.1', apiPort: CFG_PORT,
    stateFile: path.join(TMP, 'state.json'),
    logFile: path.join(TMP, 'events.log'), supervisorLogFile: path.join(TMP, 'guard.log'),
    dshLogFile: path.join(TMP, 'dsh.log'), upgradeLogFile: path.join(TMP, 'up.log'),
  };
  const cfgPath = path.join(TMP, 'cfg.json');
  fs.writeFileSync(cfgPath, JSON.stringify(cfg));

  const sup = new Supervisor(cfg, cfgPath);
  await sup.start();
  try {
    let up = false;
    for (let i = 0; i < 50; i++) { const r = await request(CFG_PORT, 'GET', '/status'); if (r.code === 200) { up = true; break; } await sleep(200); }
    check('守卫在真实绑定端口就绪', up);
    check('真实绑定端口 == config.apiPort 初始值', CFG_PORT === cfgPortOf(sup), CFG_PORT + ' vs ' + cfgPortOf(sup));

    // 模拟「冻结值 ≠ 真实绑定端口」：把 config.apiPort 改指另一端口（不改真实绑定）
    sup.config.apiPort = FROZEN_PORT;
    check('已制造双源发散：config.apiPort(' + FROZEN_PORT + ') ≠ 真实绑定端口(' + CFG_PORT + ')', FROZEN_PORT !== CFG_PORT);

    console.log('== 修复后：CORS 以真实绑定端口为唯一真相 ==');
    // Origin 落在「真实绑定端口」CFG_PORT → 应放行（哪怕 config.apiPort 已改）
    let r = await request(CFG_PORT, 'GET', GATED, { Host: '127.0.0.1:' + CFG_PORT, Origin: 'http://127.0.0.1:' + CFG_PORT });
    check('Origin=真实绑定端口 → 放行（非 403）', r.code !== 403, String(r.code));

    // Origin 落在「冻结 config.apiPort」FROZEN_PORT → 应拒绝（证明不再盲信冻结值）
    let r2 = await request(CFG_PORT, 'GET', GATED, { Host: '127.0.0.1:' + CFG_PORT, Origin: 'http://127.0.0.1:' + FROZEN_PORT });
    check('Origin=冻结 config.apiPort → 拒绝 403（不再作为真相）', r2.code === 403, String(r2.code));

    console.log('== 安全面：外来 Origin 仍 fail-closed ==');
    const bad = await request(CFG_PORT, 'POST', '/lifecycle/dsh/stop', { Host: '127.0.0.1:' + CFG_PORT, Origin: 'http://evil.example.com' });
    check('外来 Origin 写请求仍拒 403', bad.code === 403, String(bad.code));
  } finally {
    try { await sup.stop(); } catch {}
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  }
  console.log('\n==============================');
  console.log('结果: ' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed > 0 ? 1 : 0);
}

function cfgPortOf(sup) { return sup.config.apiPort; }

main().catch((e) => { console.error('single-port-truth test error:', e); process.exit(1); });
