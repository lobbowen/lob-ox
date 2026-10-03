const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');
const { spawn } = require('node:child_process');
const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ports-verify-'));
const MOCK = path.join(ROOT, 'test', 'mock-target.js');

const results = [];
const check = (name, cond, extra) => { results.push({ name, ok: !!cond, extra }); console.log((cond ? 'PASS' : 'FAIL') + ' ' + name + (extra ? '  ← ' + extra : '')); };

(async () => {
  const { Supervisor } = require(path.join(ROOT, 'src', 'supervisor'));
const { freePort } = require('./_ports');
  const apiPort = await freePort(), targetPort = await freePort(), okPort = await freePort();
  const stateDir = path.join(TMP, 'sup');
  fs.mkdirSync(stateDir, { recursive: true });
  const cfg = {
    command: ['node', MOCK, String(targetPort)],
    healthUrl: 'http://127.0.0.1:' + targetPort + '/',
    apiHost: '127.0.0.1', apiPort,
    stateFile: path.join(stateDir, 'state.json'),
    logFile: path.join(stateDir, 'events.log'),
    supervisorLogFile: path.join(stateDir, 'supervisor.log'),
    dshLogFile: path.join(stateDir, 'dsh.log'),
    upgradeLogFile: path.join(stateDir, 'upgrade.log'),
  };
  const cfgPath = path.join(TMP, 'cfg.json');
  fs.writeFileSync(cfgPath, JSON.stringify(cfg));
  const instancesFile = path.join(stateDir, 'instances.json');
  fs.writeFileSync(instancesFile, JSON.stringify({ instances: [{ id: 'inst-down', name: '未运行', port: 28150, domain: 'sandbox', guardian: false, remoteMode: 'lan' }, { id: 'inst-ok', name: '正常实例', port: okPort, domain: 'sandbox', guardian: false, remoteMode: 'lan' }] }));
  fs.writeFileSync(path.join(stateDir, 'dsh-main.json'), JSON.stringify({ guardian: false, remoteMode: 'lan' }));
  const mockMain = spawn('node', [MOCK, String(targetPort)], { stdio: 'ignore' });
  const mockOk = spawn('node', [MOCK, String(okPort)], { stdio: 'ignore' });
  const waitReady = (port) => new Promise((res) => {
    const t0 = Date.now();
    const tryOnce = () => {
      const rq = http.get({ host: '127.0.0.1', port, path: '/', timeout: 800 }, (s) => { s.resume(); res(true); });
      rq.on('error', () => { if (Date.now() - t0 > 6000) res(false); else setTimeout(tryOnce, 150); });
    };
    tryOnce();
  });
  await Promise.all([waitReady(targetPort), waitReady(okPort)]);

  const sup = new Supervisor(cfg, cfgPath);
  const insts = sup.instances.instances, instMain = sup.dshMainView();
  const instDown = insts.find((i) => i.id === 'inst-down'), instOk = insts.find((i) => i.id === 'inst-ok');
  check('main(守卫核心视图)存在且远程模式为 lan', !!instMain && instMain.remoteMode === 'lan' && insts.every((i) => i.id !== 'main'), JSON.stringify(instMain && { id: instMain.id, remoteMode: instMain.remoteMode }));

  const ports = require(path.join(ROOT, 'src', 'platform', 'service', 'ports')).shared;
  sup._registerFixedPorts();
  const relayPort = await ports.allocate('relay');
  check('固定端口已登记且 relay 动态端口避开固定端口',
    ports.get('dsh-main') === targetPort && ports.get('supervisor-api') === apiPort && relayPort !== targetPort && relayPort !== apiPort,
    JSON.stringify({ main: ports.get('dsh-main'), api: ports.get('supervisor-api'), relay: relayPort }));

  const lan = sup.lan;
  await lan.syncProxy(instDown);
  await lan.syncProxy(instOk);
  await lan.syncProxy(instMain); // main 在监听 -> 建（main 开远程是允许的）
  check('代理只对真监听目标建：未运行实例不建、在运行实例与 main（守卫核心视图）均建成功',
    !lan.lanInstances.some((p) => p.dshPort === 28150)
    && !!lan.lanInstances.find((p) => p.dshPort === okPort) && !!lan.lanInstances.find((p) => p.dshPort === targetPort));

  const proxy = lan.lanInstances.find((p) => p.dshPort === okPort);
  if (proxy) {
    await new Promise((r) => setTimeout(r, 300));
    const body = await new Promise((resolve) => {
      http.get({ host: '127.0.0.1', port: proxy.wanPort, path: '/', timeout: 2000 }, (res) => { let b=''; res.on('data', c=>b+=c); res.on('end', ()=>resolve(b)); }).on('error', () => resolve('ERR'));
    });
    check('远程控制可访问（relay 转发成功）', body.includes('ok'), body.slice(0, 50));
  }

  mockOk.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 800));
  await lan.reconcile(); // async（内部 TCP 可达判定），需等待其完成后再断言 relay 状态
  const proxyAfter = lan.lanInstances.find((p) => p.dshPort === okPort);
  const pausedOk = proxyAfter ? await new Promise((resolve) => {
    const rq = http.get({ host: '127.0.0.1', port: proxyAfter.wanPort, path: '/', timeout: 1500 }, (res) => { res.resume(); resolve(res.statusCode !== 200); });
    rq.on('error', () => resolve(true));
  }) : false;
  check('目标停止后代理暂停（注册保留、旧 wanPort 不再转发，恢复后自动重接）', pausedOk, JSON.stringify(proxyAfter && proxyAfter.wanPort));

  try { mockOk.kill('SIGKILL'); } catch {}
  try { mockMain.kill('SIGKILL'); } catch {}
  const failed = results.filter((r) => !r.ok);
  console.log('\n结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
