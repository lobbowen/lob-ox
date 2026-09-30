#!/usr/bin/env node
'use strict';

// ---------------------------------------------------------------------------
// 运行期启动契约（壳写、内核读）门禁
//
// ## 解决的问题
//   内核自身也要执行 npm（自更新 / 装 DSH / 插件）。旧实现用 ambient PATH 的裸 npm 与 process.env；
//   GUI/服务环境的 PATH 常不含 nvm/fnm 的 npm -> 「壳能装、内核自己装不了」。现统一读壳投放的
//   <产品状态根>/supervisor/runtime.json（schema 2）。同一份事实曾在内核里被解析四处（分发安装 /
//   原生管理 / 环境探测 / 版本探测），且读取口只取 npmPath 丢掉 npmArgs —— 「node + 包内 npm-cli.js」
//   被降级成裸跑 node。本门禁把「唯一解析口 + 成对消费」钉住。
//
// ## 锁定不变量
//   R-1  read() 解析 schema2（含嵌套 node{}/npm{}）与兼容 schema1；缺失/损坏返回 null（绝不抛）
//   R-2  npmLauncher() 返回启动形态对 { program, args, version, source }；契约优先，
//        契约缺席/指向不存在的文件才退回平台解析
//   R-3  withPath() 把 nodeBinDir 置于 PATH 首位（分隔符跨平台）
//   R-4  消费点接入：分发安装 / 原生管理 / env-catalog 一律经 npmLauncher 且 program 与 args 同源
//   R-5  反向：无契约时退回 ambient（不空转） · R-6 契约 schema 版本与壳 handshake
//   R-7  单一解析口：契约缺席时退回平台解析（静态文本判据已移除） · R-8 版本号不得编造
//
// ## SR 组：另一条入站通道 —— 壳的环境观测报告（contract/shell-report.js）
//   与启动契约同目录、同性质（壳写内核读），但**永不参与 spawn**：只回答「壳最后一次看到本机
//   Node/npm/镜像源/前缀是什么时候、看到了什么」。
//   SR-1..2  没报过与读不出分得开（两种处置相反，说反一次就够把人引去查不存在的文件）
//   SR-3..6  schema handshake 与整份作废的边界（缺时戳/缺观察都算读不出）
//   SR-7..9  逐字段摊平、三态不折叠、入站即脱敏
//   SR-10..11 明细超限只截断并如实报数；超大文件不读进内存
//   SR-12 读取口永不抛（原先并列的 SR-13「全仓只有契约模块拼这个路径」是源码文本判据，已移除）
// ---------------------------------------------------------------------------

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
// 产品状态根隔离（独立于 DSH）：runtime.json 落在 <DSH_SUPERVISOR_HOME>/supervisor。
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

// -- R-5 反向：无契约 -> null + 退回平台解析（不空转）--
check('R-5 无契约时 read()=null', rc.read() === null);
{
  const l = rc.npmLauncher();
  check('R-5 无契约时 npmLauncher 退回平台解析口',
    l.source === 'path' && l.program === execPath.npmBin() && Array.isArray(l.args) && l.args.length === 0,
    JSON.stringify(l));
}

// -- schema 2（壳实投形状：扁平键 + 嵌套 node{}/npm{} 双写）--
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
  // 缺陷本体：只取 program 会把「node 跑 npm-cli.js」降级成裸跑 node —— args 非空即证明拆读必然失真。
  check('R-2 契约在场：source=contract，program 取契约绝对路径，args 与 program 成对（缺一半即失真）',
    l.source === 'contract' && l.program === NODE && l.args.length === 1 && l.args[0] === NPM_CLI,
    JSON.stringify(l));
  check('R-8 version 取壳实跑回读的 npm 版本（不是 node 版本）',
    l.version === '10.9.2' && c2.nodeVersion === 'v22.12.0' && l.version !== c2.nodeVersion, String(l.version));
}
const env = rc.withPath({ PATH: '/ambient/bin' });
check('R-3 withPath 把 nodeBinDir 置于首位且保留 ambient PATH',
  env.PATH.indexOf(NODE_DIR) === 0 && env.PATH.indexOf('/ambient/bin') > 0, env.PATH);

// -- 契约指向不存在的文件：退回平台解析，不拿悬空路径去 spawn --
writeContract({ schema: 2, npmPath: path.join(TMP, 'gone', 'npm'), npmArgs: [], nodePath: NODE, minNode: 'v22.12.0' });
{
  const l = rc.npmLauncher();
  check('R-2 契约路径不存在时退回平台解析（source=path）',
    l.source === 'path' && l.program === execPath.npmBin(), JSON.stringify(l));
}

// -- 旧壳（schema2 但无 npm.version）：版本必须为 null，不得拿 node 版本顶上 --
writeContract({ schema: 2, nodePath: NODE, nodeVersion: 'v22.12.0', nodeBinDir: NODE_DIR, npmPath: NPM, minNode: 'v22.12.0' });
{
  const l = rc.npmLauncher();
  check('R-8 壳未回读 npm 版本时 version=null（不编造），且扁平旧键仍解析出绝对 npm 与空 args',
    l.version === null && l.program === NPM && l.args.length === 0, JSON.stringify(l));
  check('R-1 只写扁平旧键时也解析出 nodeVersion', rc.read().nodeVersion === 'v22.12.0', String(rc.read().nodeVersion));
}

// -- 只写嵌套 node{}/npm{} 的壳：两形都必须认，漏一侧面板就把运行时念成 null --
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

// -- schema 1 兼容（只有顶层旧键）--
writeContract({ schema: 1, nodePath: NODE, nodeVersion: 'v22.12.0', minNode: 'v22.12.0' });
{
  const c1 = rc.read();
  const l = rc.npmLauncher();
  check('R-1 schema1 兼容：可读 minNode/nodePath；无 npm 键时退回平台解析且版本为 null',
    !!(c1 && c1.minNode === 'v22.12.0' && c1.nodePath === NODE) && l.source === 'path' && l.version === null,
    JSON.stringify({ c1, l }));
}

// -- 损坏 JSON -> null（不抛）--
fs.writeFileSync(path.join(SUP, 'runtime.json'), '{ bad json', 'utf8');
check('R-1 损坏 JSON -> null（不抛）', rc.read() === null);

// -- R-6 契约版本握手：本侧 schema 常量必须与壳写入的 schema 一致（各自断言，不跨仓读源码）--
check('R-6 契约 schema 版本 = 2（与壳 handshake）', rc.SUPPORTED_SCHEMA === 2, String(rc.SUPPORTED_SCHEMA));
// 原先此处「R-7 旧的单值 npmBin() 不再从契约模块导出」（`typeof rc.npmBin === 'undefined'`）已删：
//   断言「某个符号不存在」+ 只判 typeof，改名即红而产品等价。「唯一解析口」由 R-2 的成对判据按行为钉住。
// R-4 / R-7 / R-8 静态判据已整体移除（判据对象是源码文本，不是真实执行）。

// -- SR 组：桌面壳环境上报的接收口（壳写、内核读的文件契约，与 runtime.json 同目录但性质不同）--
//   只钉三件事：「没报过」与「读不出」分得开、三态读数不折叠、来自另一个进程的自由文本必过脱敏。
//   这里绝不做投递重试，也不许猜一份默认报告 —— 壳没报就是没报，伪装成「已经收到」会让
//   排障时读到一个本机根本没发生过的环境。
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

// -- A5/A1 工具链可见性与能力矩阵：事实走完「契约 / 平台档 -> /env/status -> 面板」整条链 --
//   源自 test/cross-platform-test.js 的 A5 段与 A1 段。**全仓唯此**：`envStatus`/`catalog`/`capabilities`
//   这个出口没有第二处覆盖，并入本文件是因为它就是「契约读取器 + 平台档」的消费面（同一 runtime.json、
//   同一解析口）。A1 的字段语义还分别由 four-platform-behavior-matrix P-4（键集合四平台一致）与
//   本门禁所在平台层的 X-4（hostService 与 status().kind 同源）覆盖，故此处只留**接线 + 形状**这一处唯此判据。
//   壳侧曾「装了 npm 却看不见 npm」；内核侧是同根因的另一半：/env/status 的 node 有三段、
//   npm 只有 detected；面板只念 Node 版本，而把 npm 标成 required 的声明式目录零消费。
//   三处各自都能自洽，合起来是「面板说就绪、实机跑不通」。
(async function () {
  const { Supervisor } = require(path.join(ROOT, 'src', 'supervisor'));
  writeContract({
    schema: 2, writtenBy: 'test',
    nodePath: NODE, nodeVersion: 'v22.12.0', nodeBinDir: NODE_DIR, minNode: 'v22.12.0',
    npmPath: NODE, npmArgs: [NPM_CLI],
    npm: { path: NODE, args: [NPM_CLI], version: '10.9.2' },
  });
  const s = new Supervisor({
    command: ['node', '-e', '0'], healthUrl: 'http://127.0.0.1:28031/', probeIntervalMs: 100000,
    apiHost: '127.0.0.1', apiPort: 28030,
    stateFile: path.join(TMP, 'state.json'), logFile: path.join(TMP, 'e.log'),
    supervisorLogFile: path.join(TMP, 's.log'), dshLogFile: path.join(TMP, 'd.log'), upgradeLogFile: path.join(TMP, 'u.log'),
  });
  const ev = await s.envStatus();
  // -- A1：能力矩阵接线（caps 只有 /env/status 这一个出口，grep 实测全仓唯此）--
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

  // 反向：契约缺席时 runtime/path 必须是 null（不编造、不拿 node 版本或占位文案顶上）。
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
