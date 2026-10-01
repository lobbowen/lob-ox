#!/usr/bin/env node
'use strict';


const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const ROOT = path.join(__dirname, '..');

const results = [];
const check = (n, c, x) => {
  results.push(!!c);
  console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  ← ' + x : ''));
};

function underFake(platform, body, opts) {
  const o = opts || {};
  const code = [
    "Object.defineProperty(process, 'platform', { value: " + JSON.stringify(platform) + " });",
    o.realPath ? '' : "process.env.PATH = ''; delete process.env.Path;",
    o.home ? ("process.env.HOME = " + JSON.stringify(o.home) + "; delete process.env.USERPROFILE;") : '',
    body,
  ].filter(Boolean).join(String.fromCharCode(10));
  try {
    return execFileSync(process.execPath, ['-e', code], { encoding: 'utf8', timeout: 15000, cwd: ROOT }).trim();
  } catch (e) {
    return 'EXECFAIL:' + ((e && e.message) || e);
  }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'platport-'));

{
  // 分派档位由实测决定：伪造 linux 且清空 PATH 下 systemd-run 必然测不到 ⇒ 必须落 portable；darwin/win32 恒 portable；未知平台恒 none。
  const kinds = { linux: 'portable', darwin: 'portable', win32: 'portable', freebsd: 'none' };
  const sets = {};
  for (const [p, want] of Object.entries(kinds)) {
    const out = underFake(p, [
      "const svc = require('./src/platform/os/service.js');",
      "const c = svc.current();",
      "process.stdout.write(JSON.stringify({ kind: c.kind, keys: Object.keys(c).sort() }));",
    ].join(String.fromCharCode(10)));
    let j = null;
    try { j = JSON.parse(out); } catch { /* EXECFAIL */ }
    check('X-3 ' + p + ' provider.kind = ' + want, !!j && j.kind === want, j ? j.kind : out.slice(0, 60));
    if (j) sets[p] = j.keys;
  }
  // 方法集一致必须对三个真实 Provider 静态对账（_testProviders 缝）：旧判据只比派发产物会静默失去覆盖面。
  const tp = require(path.join(ROOT, 'src', 'platform', 'os', 'service.js'))._testProviders;
  const norm = (o) => Object.keys(o).sort();
  const ref = JSON.stringify(norm(tp.systemd));
  const bad = Object.keys(tp).filter((k) => JSON.stringify(norm(tp[k])) !== ref);
  check('X-3 systemd/portable/NONE 三方**方法集完全一致**（含 setLimits，防"声明了却没实现"）',
    bad.length === 0 && JSON.stringify(sets.linux || []) === ref,
    bad.length ? ('不一致: ' + bad.join(',')) : (norm(tp.systemd).length + ' 个成员一致'));

  const thrown = underFake('freebsd', [
    "const svc = require('./src/platform/os/service.js');",
    "const c = svc.current();",
    "const r = [];",
    "for (const m of ['stopUnit', 'startTransient']) {",
    "  try { c[m]('x'); r.push(m + ':NO-THROW'); } catch (e) { r.push(m + ':' + (/无服务管理器/.test(e.message) ? 'labeled' : 'unlabeled')); }",
    "}",
    "process.stdout.write(r.join(' '));",
  ].join(String.fromCharCode(10)));
  check('X-3 未知平台 stopUnit/startTransient 显式抛错且带档位标签',
    /stopUnit:labeled/.test(thrown) && /startTransient:labeled/.test(thrown), thrown);
  const inact = underFake('freebsd', [
    "const svc = require('./src/platform/os/service.js');",
    "process.stdout.write(String(svc.current().isUnitActive('dsh-web@x')));",
  ].join(String.fromCharCode(10)));
  check('X-3 未知平台 isUnitActive(具名单元)=false（无单元可言，删除路径得以继续）',
    inact === 'false', inact);
  const inactP = underFake('win32', [
    "const svc = require('./src/platform/os/service.js');",
    "process.stdout.write(String(svc.current().isUnitActive('dsh-web@x')));",
  ].join(String.fromCharCode(10)));
  check('X-3 portable 无任何锚点时 isUnitActive=null（无从查询不得被当成已停止）',
    inactP === 'null', inactP);

  const dis = underFake('linux', [
    "const svc = require('./src/platform/os/service.js');",
    "const ep = require('./src/platform/os/exec-path.js');",
    "const ex = require('./src/platform/util/exec.js');",
    "const has = !!ep.resolveExecutable('systemd-run') || ex.runOut('systemd-run', ['--version'], { timeoutMs: 3000 }) !== null;",
    "process.stdout.write(JSON.stringify({ kind: svc.current().kind, has: has }));",
  ].join(String.fromCharCode(10)), { realPath: true });
  let dj = null;
  try { dj = JSON.parse(dis); } catch { /* EXECFAIL */ }
  check('X-3 linux 分派 = systemd-run 实测（有=systemd / 无=portable，不随宿主写死）',
    !!dj && dj.kind === (dj.has ? 'systemd' : 'portable'), dis.slice(0, 60));
}

{
  const out = underFake('linux', [
    "const fs=require('fs'), os=require('os'), path=require('path');",
    "const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-port-'));",
    "const pf=path.join(tmp,'run.pid');",
    "const CMD='node /opt/inst/install/lib/node_modules/@deepseek-ai/dsh/lib/bin.js web --port 8111';",
    // stopUnit 会对 run.pid 发真实信号 ⇒ 必须用一个探测出的不存在的 pid，绝不误伤宿主上的无关进程。
    "let FP=null; for (let q=4194200;q>4190000;q--){ try { process.kill(q,0); } catch (e) { FP=q; break; } }",
    "if (FP===null) { process.stdout.write('{\"FPFAIL\":true}'); process.exit(0); }",
    "let alive=true, cmd=CMD, listen=null, calls=0, limit=1e9;",
    "const plPath=require.resolve('./src/platform/os/pidlookup');",
    "require.cache[plPath]={ id: plPath, filename: plPath, loaded: true, exports: {",
    "  isAlive: function(){ calls++; return alive && calls<=limit; },",
    "  readCmdline: function(){ return cmd; },",
    "  findListeningPid: function(){ return listen; },",
    "} };",
    "const { portable, _test } = require('./src/platform/os/portable.js');",
    "const r={};",
    "fs.writeFileSync(pf,'4242');",
    "r.pidOk=_test.readPidFile(pf)===4242;",
    "fs.writeFileSync(pf,'garbage'); r.pidBad=_test.readPidFile(pf)===null;",
    "r.pidMissing=_test.readPidFile(path.join(tmp,'nope.pid'))===null;",
    "fs.writeFileSync(pf,String(FP));",
    "r.anchorHit=_test.matchesAnchors(4242,['--port 8111'])===true;",
    "r.anchorMiss=_test.matchesAnchors(4242,['nope'])===false;",
    "r.anchorEmpty=_test.matchesAnchors(4242,[])===false;",
    "const ctx={port:8111,pidFile:pf,anchors:['/opt/inst/install/lib/node_modules/@deepseek-ai/dsh/lib/bin.js','--port 8111']};",
    "const f1=_test.findOurs(ctx); r.pfOwn=!!f1&&f1.pid===FP&&f1.ownGroup===true;",
    "cmd='unrelated process'; const f2=_test.findOurs(ctx); r.anchorMismatchNull=f2===null;",
    "cmd=CMD; alive=false; listen=9999; const f3=_test.findOurs(ctx); r.portNotOwn=!!f3&&f3.pid===9999&&f3.ownGroup===false;",
    "listen=FP; r.portEqPidfileSkipped=_test.findOurs(ctx)===null;",
    "alive=true; listen=null;",
    "r.activeTrue=portable.isUnitActive('dsh-web@x',ctx)===true;",
    "r.noAnchorNull=portable.isUnitActive('dsh-web@x',{})===null;",
    "cmd=null; r.aliveCmdUnknown=portable.isUnitActive('dsh-web@x',ctx)===null; cmd=CMD;",
    "r.noAnchorAliveTrue=portable.isUnitActive('dsh-web@x',{port:8111,pidFile:pf,anchors:[]})===true;",
    "alive=false;",
    "r.noAnchorDeadFalse=portable.isUnitActive('dsh-web@x',{port:0,pidFile:pf,anchors:[]})===false;",
    "r.noAnchorPortUnknown=portable.isUnitActive('dsh-web@x',{port:8111,pidFile:null,anchors:[]})===null;",
    "r.stopNothingTrue=portable.stopUnit('dsh-web@x',{port:8111,pidFile:path.join(tmp,'nope.pid'),anchors:[]})===true;",
    "fs.writeFileSync(pf,String(FP)); alive=true; calls=0; limit=1e9;",
    "r.stopUnconfirmedFalse=portable.stopUnit('dsh-web@x',Object.assign({timeoutMs:0},ctx))===false;",
    "calls=0; limit=2;",
    "r.stopConfirmedTrue=portable.stopUnit('dsh-web@x',Object.assign({timeoutMs:200},ctx))===true;",
    "r.pidFileCleaned=!fs.existsSync(pf);",
    "r.cleanNothingOk=portable.cleanTransient('dsh-web@x',{port:8111,pidFile:path.join(tmp,'nope.pid'),anchors:[]}).ok===true;",
    "try { portable.startTransient({ cmd: [] }); r.rejectEmptyCmd=false; } catch (e) { r.rejectEmptyCmd=/空命令/.test(e.message); }",
    "r.setLimitsFalse=portable.setLimits('dsh-web@x',{memoryMax:'1G'})===false;",
    "process.stdout.write(JSON.stringify(r));",
  ].join(String.fromCharCode(10)));
  let j = null;
  try { j = JSON.parse(out); } catch { /* EXECFAIL */ }
  const groups = [
    ['pidfile 读取三态（正常数值/垃圾串/文件缺失）', ['pidOk', 'pidBad', 'pidMissing']],
    ['锚点归属与 ownGroup 宽严（命中/不命中/空锚/端口不属我们/端口与 pidfile 同值则跳过）', ['anchorHit', 'anchorMiss', 'anchorEmpty', 'pfOwn', 'anchorMismatchNull', 'portNotOwn', 'portEqPidfileSkipped']],
    ['isUnitActive 三态（活/死/判不出）与无锚点各路径', ['activeTrue', 'noAnchorNull', 'aliveCmdUnknown', 'noAnchorAliveTrue', 'noAnchorDeadFalse', 'noAnchorPortUnknown']],
    ['stopUnit 幂等与确认、pidfile 清理、清理空转、空命令与 setLimits fail-closed', ['stopNothingTrue', 'stopUnconfirmedFalse', 'stopConfirmedTrue', 'pidFileCleaned', 'cleanNothingOk', 'rejectEmptyCmd', 'setLimitsFalse']],
  ];
  for (const [label, keys] of groups) {
    check('X-3b portable 纯逻辑：' + label,
      !!j && keys.every((k) => j[k] === true),
      j ? keys.filter((k) => j[k] !== true).map((k) => k + '=' + JSON.stringify(j[k])).join(' ') : out.slice(0, 80));
  }
}

{
  const { portable } = require(path.join(ROOT, 'src', 'platform', 'os', 'portable.js'));
  const tmpd = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-port-real-'));
  const pf = path.join(tmpd, 'run.pid');
  const port = require(path.join(__dirname, '_ports.js')).safePort('platform-layer-portability');
  const entry = path.join(tmpd, 'entry.js');
  fs.writeFileSync(entry, "require('net').createServer().listen(" + port + ",'127.0.0.1');setInterval(function(){},1000);");
  const ctx = { port, pidFile: pf, anchors: [entry] };
  let started = false;
  let startErr = '';
  try {
    started = portable.startTransient({ cmd: [process.execPath, entry], pidFile: pf }) === true
      && fs.existsSync(pf) && parseInt(fs.readFileSync(pf, 'utf8'), 10) > 0;
  } catch (e) { startErr = e && e.message; }
  check('X-3c startTransient 真拉起并落 run.pid', started, startErr || 'ok');
  check('X-3c run.pid+cmdline 锚点命中即活跃（不等端口监听）',
    started && portable.isUnitActive('dsh-web@x', ctx) === true, 'true');
  const stopOk = started && portable.stopUnit('dsh-web@x', Object.assign({ timeoutMs: 5000 }, ctx)) === true;
  check('X-3c stopUnit 确认终止（true 仅在端口与 pidfile 双锚点消失后）', stopOk, String(stopOk));
  check('X-3c 停止后 run.pid 已清、再查=false（肯定证据，非未知）',
    stopOk && !fs.existsSync(pf) && portable.isUnitActive('dsh-web@x', ctx) === false, 'false');
  try { fs.rmSync(tmpd, { recursive: true, force: true }); } catch { /* 尽力清 */ }
}

{
  const out = underFake('linux', [
    "const calls = [];",
    "const exPath = require.resolve('./src/platform/util/exec.js');",
    "require.cache[exPath] = { id: exPath, filename: exPath, loaded: true, exports: {",
    "  run: function (c, a, o) { calls.push([c, a, o]); return ''; },",
    "  runOut: function (c, a, o) { calls.push([c, a, o]); return ''; },",
    "  runDetail: function (c, a, o) { calls.push([c, a, o]); return { ok: true, stdout: '' }; },",
    "} };",
    "const svc = require('./src/platform/os/service.js');",
    "const t = svc._testProviders.systemd;",
    "const ok = t.setLimits('dsh-web@a1', { memoryMax: '2G', memoryHigh: '1800M', cpuQuota: '150%' });",
    "const argv = calls.length === 1 ? String(calls[0][1]) : 'CALLS=' + calls.length;",
    "const to = calls[0] && calls[0][2] ? calls[0][2].timeoutMs : null;",
    "calls.length = 0;",
    "const empty = t.setLimits('dsh-web@a1', {}) === false && calls.length === 0;",
    "const bad = t.setLimits('../evil', { memoryMax: '1G' }) === false && calls.length === 0;",
    "process.stdout.write(JSON.stringify({ ok: ok === true, argv: argv, to: to, empty: empty, bad: bad }));",
  ].join(String.fromCharCode(10)));
  let j = null;
  try { j = JSON.parse(out); } catch { /* EXECFAIL */ }
  check('X-3d setLimits argv 逐字：--user set-property --runtime <unit> 三属性（--runtime 防陈旧下限黏住）',
    !!j && j.ok && j.argv === ['--user', 'set-property', '--runtime', 'dsh-web@a1',
      'MemoryMax=2G', 'MemoryHigh=1800M', 'CPUQuota=150%'].join(','), j ? j.argv : out.slice(0, 80));
  check('X-3d setLimits 走有界超时（dbus 挂起不得冻结监督拍）', !!j && j.to === 10000, j ? String(j.to) : '-');
  check('X-3d 空 alloc 不发命令且返 false（无值可下发时绝不发空调用）', !!j && j.empty === true, j ? String(j.empty) : '-');
  check('X-3d 非法单元名 fail-closed（与 stopUnit 同闸，绝不进 systemctl argv）', !!j && j.bad === true, j ? String(j.bad) : '-');
}

{
  const cmds = {};
  for (const p of ['linux', 'darwin', 'win32']) {
    const out = underFake(p, [
      "const a = require('./src/platform/os/autostart');",
      // daemonCommand/guiCommand 必须给绝对路径，否则 schtasks /TR、launchd plist、XDG .desktop 拿到裸名，登录自启静默失效。
      "process.stdout.write(JSON.stringify({ d: a.daemonCommand(), g: a.guiCommand() }));",
    ].join(String.fromCharCode(10)), { home: '/H' });
    let j = null;
    try { j = JSON.parse(out); } catch { /* EXECFAIL */ }
    cmds[p] = j || { d: out, g: '' };
  }
  const base = (x) => path.basename(String(x));
  check('X-4 win32 daemonCommand 带 .exe（否则 Windows 上守卫永不起）',
    /^dsh-supervisor[.]exe$/i.test(base(cmds.win32.d)) && path.isAbsolute(cmds.win32.d), cmds.win32.d);
  check('X-4 posix daemonCommand 不带扩展名',
    base(cmds.linux.d) === 'dsh-supervisor' && base(cmds.darwin.d) === 'dsh-supervisor'
    && path.isAbsolute(cmds.linux.d) && path.isAbsolute(cmds.darwin.d),
    cmds.linux.d + ' | ' + cmds.darwin.d);
  check('X-4 guiCommand 平台差异：win32 带 .exe、posix 不带，且三端均为绝对路径',
    path.isAbsolute(cmds.win32.g) && /\.exe$/i.test(cmds.win32.g)
    && path.isAbsolute(cmds.linux.g) && !/\.exe$/i.test(cmds.linux.g)
    && path.isAbsolute(cmds.darwin.g) && !/\.exe$/i.test(cmds.darwin.g),
    [cmds.win32.g, cmds.linux.g, cmds.darwin.g].join(' | '));

  const pairs = [
    ['linux', 'systemd', 'systemd'],
    ['darwin', 'launchagent', 'launchd'],
    ['win32', 'schtasks', 'windows-service'],
    ['freebsd', 'none', 'none'],
  ];
  for (const [p, wantKind, wantHost] of pairs) {
    const out = underFake(p, [
      "const a = require('./src/platform/os/autostart');",
      "const idx = require('./src/platform/os/index.js');",
      "const s = a.status();",
      "process.stdout.write(JSON.stringify({ kind: s.kind, on: s.on, host: idx.capabilityProfile().hostService }));",
    ].join(String.fromCharCode(10)));
    let j = null;
    try { j = JSON.parse(out); } catch { /* EXECFAIL */ }
    check('X-4 ' + p + ' status().kind=' + wantKind + ' 且 hostService=' + wantHost,
      !!j && j.kind === wantKind && j.host === wantHost,
      j ? (j.kind + '/' + j.host) : out.slice(0, 60));
    if (p === 'freebsd') {
      check('X-4 未知平台 on=false（不谎报已启用）', !!j && j.on === false, j ? String(j.on) : '-');
    }
  }
  const noNoise = underFake('freebsd', [
    "const a = require('./src/platform/os/autostart');",
    "process.stdout.write(String(a.status().unit));",
  ].join(String.fromCharCode(10)));
  check('X-4 未知平台 status().unit=unsupported（不跑 systemctl 探测）',
    noNoise === 'unsupported', noNoise);
}

{
  const fp = require(path.join(ROOT, 'src', 'platform', 'os', 'file-protect.js'));
  check('X-6 hasIcacls(linux/darwin) 恒 false（POSIX 绝不探测 icacls）',
    fp.hasIcacls('linux') === false && fp.hasIcacls('darwin') === false, 'false');
  const winMissing = path.join(TMP, 'nonexistent-xyz');
  const probeBody = [
    "const fp = require('./src/platform/os/file-protect.js');",
    "const ex = require('./src/platform/util/exec.js');",
    'const f = ' + JSON.stringify(winMissing) + ';',
    "const d = ex.runDetail('icacls', ['/?'], { timeoutMs: 5000 });",
    'process.stdout.write(JSON.stringify({ i: fp.hasIcacls(), f: fp.protectFile(f), d: fp.protectDir(f),',
    "  p: { ok: d.ok, code: d.code, timedOut: d.timedOut, err: String(d.error || '').slice(0, 120), stderr: String(d.stderr || '').slice(0, 80) } }));",
  ].join(String.fromCharCode(10));
  const wOut = underFake('win32', probeBody);
  let w = null; try { w = JSON.parse(wOut); } catch { /* EXECFAIL */ }
  if (process.platform !== 'win32') {
    check('X-6 Windows 且 icacls 不可用 → protectFile/protectDir 均如实 ok=false/mode=none（不静默成功）',
      !!w && w.i === false && w.f.ok === false && w.f.mode === 'none' && !!w.f.reason
      && w.d.ok === false && w.d.mode === 'none' && !!w.d.reason,
      w ? JSON.stringify({ i: w.i, f: w.f, d: w.d }) : wOut.slice(0, 70));
  } else {
    const realOut = underFake('win32', probeBody, { realPath: true });
    let wr = null; try { wr = JSON.parse(realOut); } catch { /* EXECFAIL */ }
    // 真实 PATH 下 icacls 必须可用；判红时回显的探针字段区分「解析不到（ENOENT）」与「icacls 自身退出码非 0 = 产品缺陷」。
    check('X-6 win32 真实 PATH：icacls 可用（生产机拿不到 ACL 收紧即为缺陷，不静默放行）',
      !!wr && wr.i === true, wr ? JSON.stringify({ icacls可用: wr.i, 探针: wr.p }) : '-');
    check('X-6 win32 真实 PATH 一致性：可用 ⇒ 绝不谎报 mode=none；不可用 ⇒ 如实 ok=false/mode=none',
      !!wr && (wr.i === true
        ? (wr.f.mode !== 'none' && wr.d.mode !== 'none')
        : (wr.f.ok === false && wr.f.mode === 'none' && wr.d.ok === false && wr.d.mode === 'none')),
      wr ? JSON.stringify({ icacls可用: wr.i, f: wr.f, d: wr.d }) : '-');
  }
  if (process.platform !== 'win32') {
    const t = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-'));
    const file = path.join(t, 'x');
    fs.writeFileSync(file, 'x');
    const r = fp.protectFile(file);
    const d = fp.protectDir(t);
    check('X-6 POSIX protectFile → ok/posix-0600 且实际 0600；protectDir → ok/posix-0700',
      r.ok === true && r.mode === 'posix-0600' && (fs.statSync(file).mode & 0o777) === 0o600
      && d.ok === true && d.mode === 'posix-0700', JSON.stringify([r, d]));
    fs.rmSync(t, { recursive: true, force: true });
  }
}

{
  const ni = require(path.join(ROOT, 'src', 'platform', 'os', 'netinfo.js'));
  check('X-7 pick：滤掉虚拟/回环/链路本地接口，默认路由网卡优先且同网卡静态地址优先',
    JSON.stringify(ni.pick([
      { iface: 'docker0', addr: '172.17.0.1', dyn: false },
      { iface: 'eth0', addr: '169.254.1.1', dyn: false },
      { iface: 'wlan0', addr: '192.168.1.50', dyn: true },
      { iface: 'eth0', addr: '10.0.0.9', dyn: false },
      { iface: 'eth0', addr: '10.0.0.8', dyn: true },
      { iface: 'wlan0', addr: '192.168.1.51', dyn: false },
    ], 'wlan0')) === JSON.stringify(['192.168.1.51', '10.0.0.9']),
    JSON.stringify(ni.pick([{ iface: 'wlan0', addr: '192.168.1.50', dyn: true }], 'wlan0')));
  for (const [p, want] of [['linux', true], ['darwin', true], ['win32', true], ['freebsd', false]]) {
    const out = underFake(p, [
      "const ni = require('./src/platform/os/netinfo.js');",
      "let r;",
      "try { r = { supported: ni.supported, n: ni.lanAddresses().length, threw: false }; }",
      "catch (e) { r = { supported: ni.supported, n: -1, threw: true }; }",
      "process.stdout.write(JSON.stringify(r));",
    ].join(String.fromCharCode(10)));
    let j = null; try { j = JSON.parse(out); } catch { /* EXECFAIL */ }
    check('X-7 ' + p + ' supported=' + want + ' 且 lanAddresses 不抛异常',
      !!j && j.supported === want && j.threw === false, j ? JSON.stringify(j) : out.slice(0, 60));
    if (!want) {
      check('X-7 未知平台 lanAddresses() 显式返回 []（不猜地址）', !!j && j.n === 0, j ? String(j.n) : '-');
    }
  }
}

{
  const ep = require(path.join(ROOT, 'src', 'platform', 'os', 'exec-path.js'));

  const winNames = ep.candidateNames('npm', 'win32');
  check('X-1 win32 候选名：.exe/.cmd 显式且靠前（不依赖 PATHEXT 兜底 —— P1-C 的核心），无扩展名兜底在末位',
    winNames.includes('npm.cmd') && winNames.indexOf('npm.exe') <= 2 && winNames.indexOf('npm.cmd') === winNames.indexOf('npm.exe') + 1
    && winNames.includes('npm.bat') && winNames[winNames.length - 1] === 'npm',
    JSON.stringify(winNames));
  check('X-1 posix 候选名只有裸名（不引入扩展名）',
    JSON.stringify(ep.candidateNames('npm', 'linux')) === JSON.stringify(['npm'])
    && JSON.stringify(ep.candidateNames('npm', 'darwin')) === JSON.stringify(['npm']),
    JSON.stringify(ep.candidateNames('npm', 'linux')));

  const wDirs = ep.standardDirs('win32', '/H', { APPDATA: '/A', LOCALAPPDATA: '/L' });
  // 分隔符归一化：Windows 单反斜杠路径必须被识别（只匹配两个反斜杠的写法在 win 上不生效）。
  const norm = (d) => String(d).replace(/[\\/]+/g, '/');
  check('X-1 win32 标准目录含 APPDATA\\npm、LOCALAPPDATA\\Programs\\dsh-supervisor 与 .local/bin 兼容目录',
    wDirs.some((d) => d === path.join('/A', 'npm'))
    && wDirs.some((d) => d === path.join('/L', 'Programs', 'dsh-supervisor'))
    && wDirs.some((d) => norm(d).endsWith('/.local/bin')), JSON.stringify(wDirs));
  const lDirs = ep.standardDirs('linux', '/H');
  check('X-1 linux 标准目录含 .local/bin 与 .npm-global/bin',
    lDirs.includes(path.join('/H', '.local', 'bin')) && lDirs.includes(path.join('/H', '.npm-global', 'bin')),
    JSON.stringify(lDirs));
  const dDirs = ep.standardDirs('darwin', '/H');
  check('X-1 darwin 额外含 Homebrew 与 /usr/local/bin',
    dDirs.includes('/opt/homebrew/bin') && dDirs.includes('/usr/local/bin'), JSON.stringify(dDirs));
}

{
  const ep = require(path.join(ROOT, 'src', 'platform', 'os', 'exec-path.js'));
  const fakeBin = path.join(TMP, 'winbin');
  fs.mkdirSync(fakeBin, { recursive: true });
  const fakeCmd = path.join(fakeBin, 'npm.cmd');
  fs.writeFileSync(fakeCmd, '@echo off\r\n');
  const env = { PATH: fakeBin, APPDATA: '', LOCALAPPDATA: '' };

  const winResolved = ep.npmBin({ platform: 'win32', env });
  check('X-2 win32 + 注入 env：npmBin 命中注入目录里的 npm.cmd',
    winResolved === fakeCmd, winResolved);
  check('X-2 win32 结果**不带** POSIX 宿主痕迹（不泄漏 process.env.PATH）',
    winResolved.indexOf(fakeBin) === 0 && !/nvm|\/bin\/npm$/.test(winResolved), winResolved);
  check('X-2 linux/darwin + 同一 env：npmBin 仍返回裸 npm（绝不解析 .cmd）',
    ep.npmBin({ platform: 'linux', env }) === 'npm' && ep.npmBin({ platform: 'darwin', env }) === 'npm',
    ep.npmBin({ platform: 'linux', env }));

  const emptyDir = path.join(TMP, 'empty');
  fs.mkdirSync(emptyDir, { recursive: true });
  check('X-2 win32 解析不到时 npm/npx 回退 .cmd（不是裸名，否则 Windows 必 ENOENT）',
    ep.npmBin({ platform: 'win32', env: { PATH: emptyDir } }) === 'npm.cmd'
    && ep.npxBin({ platform: 'win32', env: { PATH: emptyDir } }) === 'npx.cmd',
    ep.npmBin({ platform: 'win32', env: { PATH: emptyDir } }));
  const fakeNpx = path.join(fakeBin, 'npx.cmd');
  fs.writeFileSync(fakeNpx, '@echo off\r\n');
  check('X-2 npx win32 命中注入的 npx.cmd',
    ep.npxBin({ platform: 'win32', env }) === fakeNpx, ep.npxBin({ platform: 'win32', env }));
  check('X-2 resolveExecutable 对不存在的名字返回 null（不拿不可执行路径去 spawn）',
    ep.resolveExecutable('dsh-nonexistent-xyz-123', { platform: 'linux', env: { PATH: emptyDir } }) === null, 'null');
}

{
  const ep = require(path.join(ROOT, 'src', 'platform', 'os', 'exec-path.js'));
  const nf = path.join(TMP, 'plain-0644');
  fs.writeFileSync(nf, 'x', { mode: 0o644 });
  if (process.platform !== 'win32') {
    check('X-9 POSIX 0644 普通文件 → isExecutableFile=false（旧 isFile 判定会误报已安装）',
      ep.isExecutableFile(nf) === false, String(ep.isExecutableFile(nf)));
    check('X-9 POSIX /bin/sh → true（正反例配对，判据非空转）',
      ep.isExecutableFile('/bin/sh') === true, String(ep.isExecutableFile('/bin/sh')));
  }
  check('X-9 win32 无执行位语义（注入 platform=win32 对 0644 恒 true）；不存在路径 → false（不抛）',
    ep.isExecutableFile(nf, 'win32') === true && ep.isExecutableFile(path.join(TMP, 'no-such-bin')) === false,
    String(ep.isExecutableFile(nf, 'win32')));
}

{
  const fp = require(path.join(ROOT, 'src', 'platform', 'os', 'file-protect.js'));
  const dir = path.join(TMP, 'priv');
  const pr = fp.ensurePrivateDir(dir);
  let modeOk = pr.ok === true;
  let contentOk = false;
  if (process.platform !== 'win32') {
    modeOk = modeOk && (fs.statSync(dir).mode & 0o777) === 0o700;
    const f = path.join(dir, 'secret.json');
    const fr = fp.writePrivate(f, '{"token":"x"}');
    modeOk = modeOk && fr.ok === true && (fs.statSync(f).mode & 0o777) === 0o600;
    contentOk = fr.ok === true && JSON.parse(fs.readFileSync(f, 'utf8')).token === 'x';
  } else {
    modeOk = modeOk && (pr.mode === 'icacls-dir' || pr.mode === 'none');
  }
  check('X-6b ensurePrivateDir/writePrivate 真权限位（POSIX 0700/0600；win 走 icacls 或明确降级）',
    modeOk, JSON.stringify(pr));
  if (process.platform !== 'win32') {
    check('X-6b writePrivate 内容正确且无 .tmp 残留（原子写不落半份）',
      contentOk && !fs.readdirSync(dir).some((n) => n.includes('.tmp')), JSON.stringify(fs.readdirSync(dir)));
  }
  check('X-6b protectFile 对不存在路径返回 ok=false 而非抛出（不在 spawn 前埋 ENOENT）',
    (() => { try { return fp.protectFile(path.join(TMP, 'nope')).ok === false; } catch { return false; } })(), '');
}

{
  const { Supervisor } = require(path.join(ROOT, 'src', 'supervisor'));
  const s = new Supervisor({
    command: ['node', '-e', '0'], healthUrl: 'http://127.0.0.1:28031/', probeIntervalMs: 100000,
    apiHost: '127.0.0.1', apiPort: 28030,
    stateFile: path.join(TMP, 'state.json'), logFile: path.join(TMP, 'e.log'),
    supervisorLogFile: path.join(TMP, 's.log'), dshLogFile: path.join(TMP, 'd.log'), upgradeLogFile: path.join(TMP, 'u.log'),
  });
  check('X-12 statusSummary 暴露 dataDirProtected（面板据此判状态根是否已收紧）',
    s.statusSummary().dataDirProtected === true, String(s.statusSummary().dataDirProtected));
}

(async function () {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const carrier = require(path.join(ROOT, 'src', 'platform', 'os', 'carrier'));
  const pidlookup = require(path.join(ROOT, 'src', 'platform', 'os', 'pidlookup'));
  const PORT = require(path.join(__dirname, '_ports.js')).safePort('platform-layer-portability', 1);
  const PKG_MARKER = 'fakeproxy-demo-pkg';
  const dir = path.join(TMP, PKG_MARKER);
  fs.mkdirSync(dir, { recursive: true });
  const entry = path.join(dir, 'entry.js');
  fs.writeFileSync(entry, "'use strict';\n"
    + "const http = require('node:http');\n"
    + "const argv = process.argv.slice(2);\n"
    + "const port = Number(argv[argv.indexOf('--port') + 1]);\n"
    + "const srv = http.createServer((req, res) => { if (req.url === '/health') { res.writeHead(200); res.end('{\"ok\":true}'); } else { res.writeHead(404); res.end(); } });\n"
    + "srv.listen(port, '127.0.0.1');\n"
    + "setTimeout(() => process.exit(0), 30000).unref();\n"
    + "process.on('SIGTERM', () => process.exit(0));\n");
  const pidFile = path.join(dir, 'run.pid');
  const identity = { port: PORT, pidFile, anchors: [PKG_MARKER, '--port ' + PORT] };
  const spawnFake = () => carrier.start({
    cmd: [process.execPath, entry, PKG_MARKER, '--host', '127.0.0.1', '--port', String(PORT)],
    identity,
  });
  let h = spawnFake();
  check('X-11 start 正 pid + run.pid 落盘一致',
    Number.isInteger(h.pid) && h.pid > 0 && parseInt(String(fs.readFileSync(pidFile, 'utf8')), 10) === h.pid, String(h.pid));
  let health = false;
  const dl = Date.now() + 10000;
  while (Date.now() < dl && !health) {
    try { health = (await fetch('http://127.0.0.1:' + PORT + '/health', { signal: AbortSignal.timeout(1000) })).ok; } catch { await sleep(250); }
  }
  check('X-11 真监听：/health 200（本平台 spawn→端口全链可用）', health, health ? 'ok' : '10s 超时');
  const st1 = carrier.probe(identity);
  check('X-11 归属 ours（pidFile+锚点）', st1.state === 'ours' && st1.pid === h.pid, JSON.stringify(st1));
  fs.unlinkSync(pidFile);
  check('X-11 无 run.pid 时端口锚点仍 ours（npx 子孙监听形态）', carrier.probe(identity).state === 'ours', JSON.stringify(carrier.probe(identity)));
  const stF = carrier.probe({ port: PORT, pidFile: null, anchors: ['no-such-vendor-pkg'] });
  check('X-11 错锚点判 foreign（绝不误认领他人进程——孤儿误杀类反例锁）', stF.state === 'foreign', JSON.stringify(stF));
  carrier.signalTermination(h.pid);
  let gone = false;
  const dl2 = Date.now() + 6000;
  while (Date.now() < dl2 && !gone) { gone = !pidlookup.isAlive(h.pid); if (!gone) await sleep(200); }
  check('X-11 signalTermination 后真退', gone, gone ? 'ok' : '6s 未退');
  let freed = false;
  const dl3 = Date.now() + 4000;
  while (Date.now() < dl3 && !freed) { freed = pidlookup.findListeningPid(PORT) === null; if (!freed) await sleep(200); }
  check('X-11 端口释放（无占端口孤儿）+ probe 收敛 dead', freed && carrier.probe(identity).state === 'dead', freed ? 'ok' : '仍被监听');
  h = spawnFake();
  check('X-11 同端口重拉 + 确认式 stop true 且清 run.pid',
    carrier.stop(identity, { timeoutMs: 3000 }) === true && !fs.existsSync(pidFile), 'ok');

  finish();
})();

function finish() {
  fs.rmSync(TMP, { recursive: true, force: true });
  const failed = results.filter((r) => !r);
  console.log(String.fromCharCode(10) + '结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
  process.exit(failed.length ? 1 : 0);
}
