#!/usr/bin/env node
'use strict';

// app state/config 持久化的 **fail-closed 拒写**纪律（createDesired / createMainStore / lan-panel 三个写口）：
//   读不到或解析不了既存配置时一律拒绝写回并保留原字节 —— config.json 半截/根为数组/EISDIR、
//   dsh-main.json 损坏（默认值覆盖 = 令牌静默清零 -> 零认证降级，显式重设是唯一解锁）。

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');

const results = [];
const check = (n, c, x) => {
  results.push(!!c);
  console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  <- ' + x : ''));
};

const { createDesired } = require(path.join(ROOT, 'src', 'app', 'state', 'desired.js'));
const { createMainStore } = require(path.join(ROOT, 'src', 'app', 'state', 'main-store.js'));

// config.json 读/解析失败 -> **拒绝写回**（fail-closed）且原字节保留；仅 ENOENT（首启）照常写入。
{
  const t = fs.mkdtempSync(path.join(os.tmpdir(), 'a1-config-'));
  const cf = path.join(t, 'config.json');
  const warns = []; const evs = [];
  const d = createDesired({
    getConfigPath: () => cf,
    getConfigAliases: () => [['switcherAutoStart', 'routerAutostart']],
    getLogger: () => ({ warn: (m) => warns.push(String(m)) }),
    getEvents: () => ({ append: (e) => evs.push(e) }),
    fields: {}, store: {},
  });
  check('A1a 首启（文件缺失）仍照常写入 —— 不伤可用性',
    d.persistConfigPatch({ apiPort: 8080 }) === true
    && JSON.parse(fs.readFileSync(cf, 'utf8')).apiPort === 8080, 'ok');
  fs.writeFileSync(cf, '{"apiAccessKey":"SECRET","swit');
  check('A1a 半截 JSON → false 且**原字节保留**（未被派生内容覆盖）',
    d.persistConfigPatch({ apiPort: 9 }) === false
    && fs.readFileSync(cf, 'utf8') === '{"apiAccessKey":"SECRET","swit', 'ok');
  check('A1a 根为数组 / 读失败（EISDIR，非 ENOENT）同样拒绝 —— 同一 fail-closed 判据的两个非 ENOENT 输入',
    (() => { fs.writeFileSync(cf, '[1,2]'); return d.persistConfigPatch({ apiPort: 9 }) === false && fs.readFileSync(cf, 'utf8') === '[1,2]'; })()
    && (() => { fs.rmSync(cf); fs.mkdirSync(cf); return d.persistConfigPatch({ apiPort: 9 }) === false; })(), 'ok');
  fs.rmSync(cf, { recursive: true });
  check('A1a 故障解除后可正常再写',
    d.persistConfigPatch({ apiPort: 7 }) === true && JSON.parse(fs.readFileSync(cf, 'utf8')).apiPort === 7, 'ok');

  // -- B2-4：legacy 键清理由别名字典驱动（与 domain-config 声明同源，不硬编码键名）--
  fs.rmSync(cf);
  fs.writeFileSync(cf, JSON.stringify({ switcherAutoStart: true }));
  d.persistConfigPatch({ apiPort: 6001 });
  check('B2-4 新键未落盘时旧键保留（旧键可能是唯一意图，预删=静默丢失）',
    JSON.parse(fs.readFileSync(cf, 'utf8')).switcherAutoStart === true, 'ok');
}

// dsh-main.json 损坏 -> 读回默认值但标记 corrupt，后续**不带显式 remoteToken 的写回一律拒绝**
//   （默认值覆盖 = 令牌静默清零 -> 零认证降级）；显式重设令牌是唯一解锁路径。
{
  const t = fs.mkdtempSync(path.join(os.tmpdir(), 'a1-main-'));
  const sf = path.join(t, 'state.json');
  const mf = path.join(t, 'dsh-main.json');
  const warns = [];
  const mkStore = () => createMainStore({ getConfig: () => ({ stateFile: sf }), getLogger: () => ({ warn: (m) => warns.push(String(m)) }) });
  mkStore().writeDshMain({ guardian: true, remoteToken: 'TK-1' }); // 首启：无文件照常写
  const first = JSON.parse(fs.readFileSync(mf, 'utf8')).remoteToken;
  fs.writeFileSync(mf, '{"guardian":true,"remoteToken":"TK-SECRET"'); // 损坏态
  const ms = mkStore();
  ms.writeDshMain({ guardian: true }); // 先写后读：内部首次读即判 corrupt
  check('A1b 首启写入正常；corrupt 态**拒绝默认值覆盖写**（原字节保留）',
    first === 'TK-1' && fs.readFileSync(mf, 'utf8') === '{"guardian":true,"remoteToken":"TK-SECRET"', fs.readFileSync(mf, 'utf8').slice(0, 24));
  const meta = ms.readDshMain();
  check('A1b 读回降级为默认值（remoteToken 清空）且不写回盘',
    meta.remoteToken === '', JSON.stringify(meta).slice(0, 120));
  ms.writeDshMain({ remoteToken: 'TK-RESET' });
  check('A1b 唯一解锁：显式重设 remoteToken 可写回',
    JSON.parse(fs.readFileSync(mf, 'utf8')).remoteToken === 'TK-RESET', fs.readFileSync(mf, 'utf8').slice(0, 60));
  ms.writeDshMain({ guardian: true });
  check('A1b 解锁后普通写恢复', JSON.parse(fs.readFileSync(mf, 'utf8')).guardian === true, 'ok');
}

// B2-4 lan-panel 写口归一：setLanPanel 不自拼 read-merge-write，与 access.js 同口径走
//   state.persistConfigPatch（唯一入口）+ verifyPersisted（写后读回）；配置损坏时原字节保留且回 ok:false。
{
  const t = fs.mkdtempSync(path.join(os.tmpdir(), 'b24-lanpanel-'));
  const cf = path.join(t, 'config.json');
  const lpMethods = require(path.join(ROOT, 'src', 'app', 'settings', 'lan-panel.js')).methods;
  const mk = () => {
    const state = createDesired({
      getConfigPath: () => cf,
      getLogger: () => ({ warn() {} }),
      getEvents: () => ({ append() {} }),
      fields: {}, store: {},
    });
    // 重绑门控是「changed && api().close 存在」；此处只需满足换 cookie 口的形状。
    return Object.assign({}, lpMethods, {
      config: { apiHost: '0.0.0.0', apiPort: 3080, apiAccessKey: 'k' },
      configPath: cf, logger: { warn() {}, info() {}, error() {} },
      events: { append() {} }, state, api: { close() {} }, _apiRebind() {},
    });
  };
  {
    fs.writeFileSync(cf, '{"apiAccessKey":"SECRET","swit'); // 半截 JSON
    const r = mk().setLanPanel(false);
    check('B2-4 配置损坏：经 fail-closed 单源拒写、原字节保留、如实回 ok:false',
      r.ok === false && fs.readFileSync(cf, 'utf8') === '{"apiAccessKey":"SECRET","swit', JSON.stringify(r.error));
  }
}

const failed = results.filter((r) => !r);
console.log(String.fromCharCode(10) + '结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
process.exit(failed.length ? 1 : 0);
