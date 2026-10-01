#!/usr/bin/env node
'use strict';

// runtime.json（schema 2）是唯一解析口，program/args 必须成对消费（只取 npmPath 会把「node + 包内 npm-cli.js」降级成裸跑 node）。

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const rc = require(path.join(ROOT, 'src', 'platform', 'contract', 'runtime.js'));
const sr = require(path.join(ROOT, 'src', 'platform', 'contract', 'shell-report.js'));
const execPath = require(path.join(ROOT, 'src', 'platform', 'os', 'exec-path.js'));

const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  <- ' + x : '')); };

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'rtc-'));
process.env.DSH_SUPERVISOR_HOME = TMP;
const SUP = path.join(TMP, 'supervisor');
fs.mkdirSync(SUP, { recursive: true });
const writeContract = (obj) => fs.writeFileSync(path.join(SUP, 'runtime.json'), JSON.stringify(obj, null, 2));
const NODE_DIR = path.join(TMP, 'nodebin');
fs.mkdirSync(NODE_DIR, { recursive: true });
const NODE = path.join(NODE_DIR, process.platform === 'win32' ? 'node.exe' : 'node');
const NPM = path.join(NODE_DIR, process.platform === 'win32' ? 'npm.cmd' : 'npm');
const NPM_CLI = path.join(NODE_DIR, 'npm-cli.js');
fs.writeFileSync(NODE, '#!/bin/sh\n');
fs.writeFileSync(NPM, '#!/bin/sh\n');
fs.writeFileSync(NPM_CLI, '\n');

const savedHome = process.env.HOME; const savedUp = process.env.USERPROFILE;
process.env.HOME = TMP; process.env.USERPROFILE = TMP;

check('R-5 无契约时 read()=null', rc.read() === null);
{
  const l = rc.npmLauncher();
  check('R-5 无契约时 npmLauncher 退回平台解析口',
    l.source === 'path' && l.program === execPath.npmBin() && Array.isArray(l.args) && l.args.length === 0,
    JSON.stringify(l));
}

writeContract({
  schema: 2, writtenBy: 'test',
  nodePath: NODE, nodeVersion: 'v22.12.0', nodeBinDir: NODE_DIR,
  npmPath: NODE, npmArgs: [NPM_CLI],
  node: { path: NODE, binDir: NODE_DIR, version: 'v22.12.0' },
  npm: { path: NODE, args: [NPM_CLI], version: '10.9.2' },
  minNode: 'v22.12.0',
});
{
  const c2 = rc.read();
  check('R-1 schema2 解析出 node/npm/binDir、npmArgs/npmVersion 与 nodeVersion',
    !!(c2 && c2.nodePath === NODE && c2.npmPath === NODE && c2.nodeBinDir === NODE_DIR
      && c2.npmArgs[0] === NPM_CLI && c2.npmVersion === '10.9.2' && c2.nodeVersion === 'v22.12.0'),
    JSON.stringify(c2 && { n: c2.nodePath, a: c2.npmArgs, v: c2.npmVersion }));
  const l = rc.npmLauncher();
  check('R-2 契约在场：source=contract，program 取契约绝对路径，args 与 program 成对（缺一半即失真）',
    l.source === 'contract' && l.program === NODE && l.args.length === 1 && l.args[0] === NPM_CLI,
    JSON.stringify(l));
  check('R-8 version 取壳实跑回读的 npm 版本（不是 node 版本）',
    l.version === '10.9.2' && c2.nodeVersion === 'v22.12.0' && l.version !== c2.nodeVersion, String(l.version));
}
const env = rc.withPath({ PATH: '/ambient/bin' });
check('R-3 withPath 把 nodeBinDir 置于首位且保留 ambient PATH',
  env.PATH.indexOf(NODE_DIR) === 0 && env.PATH.indexOf('/ambient/bin') > 0, env.PATH);

writeContract({ schema: 2, npmPath: path.join(TMP, 'gone', 'npm'), npmArgs: [], nodePath: NODE, minNode: 'v22.12.0' });
{
  const l = rc.npmLauncher();
  check('R-2 契约路径不存在时退回平台解析（source=path）',
    l.source === 'path' && l.program === execPath.npmBin(), JSON.stringify(l));
}

writeContract({ schema: 2, nodePath: NODE, nodeVersion: 'v22.12.0', nodeBinDir: NODE_DIR, npmPath: NPM, minNode: 'v22.12.0' });
{
  const l = rc.npmLauncher();
  check('R-8 壳未回读 npm 版本时 version=null（不编造），且扁平旧键仍解析出绝对 npm 与空 args',
    l.version === null && l.program === NPM && l.args.length === 0, JSON.stringify(l));
  check('R-1 只写扁平旧键时也解析出 nodeVersion', rc.read().nodeVersion === 'v22.12.0', String(rc.read().nodeVersion));
}

writeContract({
  schema: 2,
  node: { path: NODE, binDir: NODE_DIR, version: 'v22.12.0' },
  npm: { path: NODE, args: [NPM_CLI], version: '10.9.2' },
});
{
  const c = rc.read();
  const ln = rc.npmLauncher();
  check('R-1 纯嵌套 node{}/npm{} 形状：解析出 nodePath/nodeVersion/nodeBinDir 与 npm 启动形态',
    !!(c && c.nodePath === NODE && c.nodeVersion === 'v22.12.0' && c.nodeBinDir === NODE_DIR)
    && ln.source === 'contract' && ln.args[0] === NPM_CLI && ln.version === '10.9.2',
    JSON.stringify({ p: c && c.nodePath, a: ln.args }));
}

writeContract({ schema: 1, nodePath: NODE, nodeVersion: 'v22.12.0', minNode: 'v22.12.0' });
{
  const c1 = rc.read();
  const l = rc.npmLauncher();
  check('R-1 schema1 兼容：可读 minNode/nodePath；无 npm 键时退回平台解析且版本为 null',
    !!(c1 && c1.minNode === 'v22.12.0' && c1.nodePath === NODE) && l.source === 'path' && l.version === null,
    JSON.stringify({ c1, l }));
}

fs.writeFileSync(path.join(SUP, 'runtime.json'), '{ bad json', 'utf8');
check('R-1 损坏 JSON -> null（不抛）', rc.read() === null);

check('R-6 契约 schema 版本 = 2（与壳 handshake）', rc.SUPPORTED_SCHEMA === 2, String(rc.SUPPORTED_SCHEMA));

{
  const RP = path.join(SUP, 'shell-report.json');
  const NOW = () => 2000000;
  const writeReport = (obj) => fs.writeFileSync(RP, typeof obj === 'string' ? obj : JSON.stringify(obj));

  fs.rmSync(RP, { force: true });
  const none = sr.read({ now: NOW });
  check('SR-1 壳没报过要说成 never-written（与「读不出」是两种处置），且不得同时给出任何可读字段',
    none.available === false && none.reason === 'never-written' && none.path === sr.file()
      && none.at === null && none.ageMs === null && none.node === null && none.records.length === 0
      && none.droppedRecords === 0 && none.writtenBy === null && none.schema === null && none.registry === null,
    JSON.stringify(none));

  writeReport('{ not json');
  check('SR-2 报告损坏要说成读不出而不是没写过（说反了会把故障报成这台机器的常态）',
    sr.read({ now: NOW }).reason === 'unreadable-or-schema-mismatch', 'ok');

  writeReport({ schema: sr.SUPPORTED_SCHEMA + 1, at: 1999000, node: { version: 'v99.0.0' } });
  check('SR-3 schema 不符即整份作废（字段形状变了不能靠猜；与壳侧各自断言同一个数字）',
    sr.read({ now: NOW }).reason === 'unreadable-or-schema-mismatch', 'ok');
  check('SR-6 报告 schema 版本 = 1（与壳写入侧 handshake）', sr.SUPPORTED_SCHEMA === 1, String(sr.SUPPORTED_SCHEMA));

  writeReport({ schema: 1, at: 1999000 });
  check('SR-4 只有时戳、没有任何观察的报告按读不出处理（拿空对象冒充本机实况是最难查的假账）',
    sr.read({ now: NOW }).reason === 'unreadable-or-schema-mismatch', 'ok');

  writeReport({ schema: 1, node: { version: 'v22.12.0', ok: true } });
  check('SR-5 壳没写时戳即作废（年龄无从算起，标成新鲜会把三年前的报告当刚探的）',
    sr.read({ now: NOW }).reason === 'unreadable-or-schema-mismatch', 'ok');

  writeReport({
    schema: 1, writtenBy: 'dsh-shell 1.2.8', at: NOW() - 1500,
    node: { path: '/n/node', binDir: '/n', version: 'v22.12.0', min: 'v22.12.0', ok: true },
    npm: { path: '/n/node', args: ['/n/node_modules/npm/bin/npm-cli.js'], version: '10.9.0', ok: true },
    prefix: { dir: '/p/npm', writable: false, why: 'EACCES' },
    registry: { best: 'http://usr:pwd@reg.internal:4873/', latencyMs: 88,
      probes: [{ url: 'https://registry.npmjs.org', ok: null, latencyMs: null }] },
    records: [{ probe: 'node --version', source: 'spawn', target: '/n/node', ms: 30, ok: true, note: 'ok' },
      { probe: 'ping', source: 'net', target: 'login.example.test', ms: 900, ok: null, note: 'ETIMEDOUT' }],
  });
  const rep = sr.read({ now: NOW });
  check('SR-7 一份正常报告逐字段摊平交出（npm 的 args 与 program 成对：只念 path 会把 node 版本念成 npm 版本）',
    rep.available === true && rep.reason === 'ok' && rep.ageMs === 1500 && rep.at === 1998500
      && rep.writtenBy === 'dsh-shell 1.2.8' && rep.node.ok === true && rep.node.min === 'v22.12.0'
      && rep.npm.args.length === 1 && rep.npm.version === '10.9.0'
      && rep.prefix.writable === false && rep.prefix.why === 'EACCES'
      && rep.records.length === 2 && rep.records[0].probe === 'node --version', JSON.stringify(rep));
  check('SR-8 反向：三态读数不得折叠（ok:null 折成 false 会把「壳判不出」显示成「壳判失败」）',
    rep.registry.probes[0].ok === null && rep.registry.probes[0].latencyMs === null
      && rep.records[1].ok === null && typeof rep.records[1].ms === 'number', JSON.stringify(rep.registry));
  check('SR-9 来自壳的自由文本在入站处就脱敏（私有镜像源常把 token 写在 URL 里，快照与界面都是泄漏面）',
    rep.registry.best === 'http://usr:***@reg.internal:4873/' && !/pwd/.test(JSON.stringify(rep)),
    JSON.stringify(rep.registry.best));

  const many = [];
  for (let i = 0; i < sr.MAX_ROWS + 3; i++) many.push({ probe: 'p' + i, ok: true });
  writeReport({ schema: 1, at: NOW() - 1, records: many });
  const cut = sr.read({ now: NOW });
  check('SR-10 明细超限只截断并把丢掉几行交出去（不撑大快照与 HTTP 响应，也不许悄悄少报）',
    cut.records.length === sr.MAX_ROWS && cut.droppedRecords === 3, JSON.stringify({ n: cut.records.length, d: cut.droppedRecords }));

  writeReport('{"schema":1,"at":1}' + 'x'.repeat(sr.MAX_BYTES));
  check('SR-11 超过字节上限即按读不出处理（那是别的进程写的东西，读侧不能假设自己看到的一定是小文件）',
    sr.read({ now: NOW }).reason === 'unreadable-or-schema-mismatch', 'ok');

  fs.rmSync(RP, { force: true });
  fs.mkdirSync(RP, { recursive: true });
  const asDir = sr.read({ now: NOW });
  check('SR-12 读取口永不抛：落点成了目录也只说读不出（接收口不得成为用户可见的失败原因）',
    asDir.available === false && asDir.reason === 'unreadable-or-schema-mismatch', JSON.stringify(asDir));
  fs.rmSync(RP, { recursive: true, force: true });
}

(async function () {
  const { Supervisor } = require(path.join(ROOT, 'src', 'supervisor'));
  writeContract({
    schema: 2, writtenBy: 'test',
    nodePath: NODE, nodeVersion: 'v22.12.0', nodeBinDir: NODE_DIR, minNode: 'v22.12.0',
    npmPath: NODE, npmArgs: [NPM_CLI],
    npm: { path: NODE, args: [NPM_CLI], version: '10.9.2' },
  });
  const s = new Supervisor({
    command: ['node', '-e', '0'], healthUrl: 'http://127.0.0.1:28031/', tickIntervalMs: 100000,
    apiHost: '127.0.0.1', apiPort: 28030,
    stateFile: path.join(TMP, 'state.json'), logFile: path.join(TMP, 'e.log'),
    supervisorLogFile: path.join(TMP, 's.log'), dshLogFile: path.join(TMP, 'd.log'), upgradeLogFile: path.join(TMP, 'u.log'),
  });
  const ev = await s.envStatus();
  check('A1-a envStatus 暴露 capabilities 对象（能力矩阵的后端出口，面板据此降级呈现）',
    !!ev.capabilities && typeof ev.capabilities === 'object', JSON.stringify(ev.capabilities));
  const caps = ev.capabilities || {};
  check('A1-b capabilities 含平台/能力字段（platform/sandboxLaunch/sandboxEnforcement/pidAdoption/hostService）',
    typeof caps.platform === 'string' && typeof caps.sandboxLaunch === 'boolean'
    && typeof caps.sandboxEnforcement === 'string' && typeof caps.pidAdoption === 'boolean'
    && typeof caps.hostService === 'string', JSON.stringify(caps));
  check('A1-c capabilities.hostService 与 capabilityProfile 同源（同一事实不得两处各说一套）',
    caps.hostService === require(path.join(ROOT, 'src', 'platform', 'os', 'index')).capabilityProfile().hostService,
    String(caps.hostService));
  check('A5-a npm 与 node 同构三段（detected/runtime/path）',
    ['detected', 'runtime', 'path'].every((k) => k in ev.npm) && ['detected', 'runtime', 'path'].every((k) => k in ev.node),
    JSON.stringify(ev.npm));
  check('A5-b npm.runtime 取契约回读的 npm 版本（不得念成 node 版本）',
    ev.npm.runtime === '10.9.2' && ev.node.runtime === 'v22.12.0', 'npm=' + ev.npm.runtime + ' node=' + ev.node.runtime);
  check('A5-c npm.path 与契约解析到的可执行同源', ev.npm.path === NODE, String(ev.npm.path));
  const items = (ev.catalog && ev.catalog.items) || {};
  const required = Object.keys(items).filter((k) => items[k] && items[k].required);
  check('A5-d catalog 必填项同时含 node 与 npm（面板按必填项渲染）',
    required.includes('node') && required.includes('npm'), required.join(','));
  check('A5-e npm 条目有 label/state（声明式目录形状稳定）',
    !!(items.npm && items.npm.label && typeof items.npm.state === 'string'), JSON.stringify(items.npm));

  fs.unlinkSync(rc.file());
  const bare = await s.envStatus();
  check('A5-f 无契约时 npm/node 的 runtime 与 path 均为 null',
    bare.npm.runtime === null && bare.npm.path === null && bare.node.runtime === null, JSON.stringify(bare.npm));

  process.env.HOME = savedHome; process.env.USERPROFILE = savedUp;
  delete process.env.DSH_SUPERVISOR_HOME;
  fs.rmSync(TMP, { recursive: true, force: true });

  const failed = results.filter((r) => !r);
  console.log(String.fromCharCode(10) + '结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
  process.exit(failed.length ? 1 : 0);
})();
