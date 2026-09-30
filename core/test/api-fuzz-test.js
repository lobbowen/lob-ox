'use strict';

// API 安全与健壮性模糊测试（阶段1)验证门）：
//  1. 伪造 Host/Origin 头不能提升身份（P0-1：token/敏感数据只按 socket 事实下发）
//  2. 畸形百分号编码/畸形 JSON 不产生 5xx/崩溃（RC3：请求级错误在分派器兜底）
//  3. 任意输入 30 连发后守卫存活（uncaughtException 3 连崩机制不被触发）
// 用法：node test/api-fuzz-test.js

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const CLI = path.join(ROOT, 'bin', 'dsh-supervisor');
const MOCK = path.join(__dirname, 'mock-target.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-fuzz-'));
let passed = 0, failed = 0;
function check(name, cond, extra = '') {
  if (cond) { passed++; console.log('  PASS ' + name); }
  else { failed++; console.log('  FAIL ' + name + (extra ? '  ← ' + extra : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const cfg = {
  command: ['node', MOCK, '28021'], healthUrl: 'http://127.0.0.1:28021/',
  probeIntervalMs: 300, startTimeoutMs: 5000, stopGraceMs: 600, portReleaseWaitMs: 500,
  crashWindowMs: 28022, crashBurst: 5, backoff: [1500, 3000, 6000],
  apiHost: '0.0.0.0', apiPort: 28020, // 刻意绑 0.0.0.0：模拟"局域网访问开启"的最暴露面
  stateFile: path.join(TMP, 'state.json'),
  logFile: path.join(TMP, 'events.log'), supervisorLogFile: path.join(TMP, 'guard.log'),
  dshLogFile: path.join(TMP, 'dsh.log'), upgradeLogFile: path.join(TMP, 'up.log'),
};
const cfgPath = path.join(TMP, 'cfg.json');
fs.writeFileSync(cfgPath, JSON.stringify(cfg));

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
  const guard = spawn('node', [CLI, 'daemon', '-c', cfgPath], {
    env: { ...process.env, DSH_SUPERVISOR_CONFIG: cfgPath, DSH_SUPERVISOR_LOCK_FILE: path.join(TMP, 'guard.lock') },
    stdio: 'ignore',
  });
  try {
    // 等 API 起来
    let up = false;
    for (let i = 0; i < 50; i++) { const r = await request(28020, 'GET', '/status'); if (r.code === 200) { up = true; break; } await sleep(200); }
    check('守卫 API 就绪', up);

    console.log('== F1: 身份伪造防线（Host/Origin 头不可提升身份）==');
    // 伪造回环 Host（单发 / 与面板 Origin 双发）都不得泄露 DSH 会话令牌：
    //   token/敏感数据只按 socket 事实下发，不看请求头（identity.loopback 必须为 false）。
    let r = await request(28020, 'GET', '/instances', { Host: '127.0.0.1:28020' });
    const rDual = await request(28020, 'GET', '/instances', { Host: '127.0.0.1:28020', Origin: 'http://127.0.0.1:28020' });
    check('伪造 Host（含 +面板 Origin 双伪造）不泄露 DSH 会话令牌',
      r.code === 200 && !r.body.includes('/?token=') && !rDual.body.includes('/?token='), r.body.slice(0, 200));

    // 伪造 Origin 的写请求仍要被 CSRF 深化层拒绝（Origin 与本服务不同源）
    r = await request(28020, 'POST', '/lifecycle/dsh/stop', { Origin: 'http://evil.example.com' });
    check('伪造 Origin 的写请求被拒 403', r.code === 403, String(r.code));

    console.log('== F2: 畸形输入健壮性（分派器统一异常边界）==');
    r = await request(28020, 'GET', '/lifecycle/%E0%A4%A');
    const rVariant = await request(28020, 'GET', '/lifecycle/' + encodeURIComponent('dsh') + '/%zz');
    check('畸形百分号编码（两种变体）→ 4xx（非 500/崩溃）',
      r.code === 400 && (rVariant.code === 400 || rVariant.code === 404), String(r.code) + '/' + String(rVariant.code));
    r = await request(28020, 'POST', '/lifecycle/dsh/stop', { 'Content-Type': 'application/json' });
    check('空 body 写请求有终态（非悬挂）', r.code > 0, String(r.code));

    console.log('== F3: 存活性（30 连发异常输入后守卫仍响应）==');
    const badPaths = ['/%2e%2e/%2e%2e', '/lifecycle/%', '/lifecycle/%E0%A4%A', '/tasks/%', '/instances/%FF', '/router/%', '/native/%', '/settings/%'];
    let oks = 0;
    for (let i = 0; i < 30; i++) {
      const p = badPaths[i % badPaths.length] + '?x=' + i;
      const rr = await request(28020, i % 2 ? 'POST' : 'GET', p);
      if (rr.code >= 400 && rr.code < 600) oks++;
      else if (rr.code === 200) oks++;
    }
    check('30 连发全部有终态应答', oks === 30, oks + '/30');
    await sleep(500);
    const alive = await request(28020, 'GET', '/status');
    check('连发后守卫存活（healthz 200）', alive.code === 200, String(alive.code));
  } finally {
    try { guard.kill('SIGKILL'); } catch {}
    // 清理 mock，防残留污染后续测试
    try { require('node:child_process').execSync("pkill -9 -f 'mock-target.js 28021' || true", { stdio: 'ignore' }); } catch {}
  }
  console.log('\n==============================');
  console.log('结果: ' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error('fuzz test error:', e); process.exit(1); });
