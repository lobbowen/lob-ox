#!/usr/bin/env node
'use strict';

// 「systemd 模板让位」行为测试。
//
// ★ 服务管理器去系统化后（唯一权威：STANDARDS.md）：真实 provider 恒为 portable
//   （`supportsUnits === false`）⇒ `_prepareSystemd()` 门控直过、**不再碰任何 systemd 目录**。
//   本文件仍注入 `supportsUnits: true` 的假 provider 来保留这段行为覆盖 —— 它是既有的
//   用户数据保护逻辑（预置同名文件不得被连坐删除、让位文件不覆盖），删掉就丢了。
//   文件末尾另加两条判据，钉死「真实 provider 下不再有 systemd 让位」。

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const ROOT = path.join(__dirname, '..');

const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  ← ' + x : '')); };

// 假 service 必须在 require 实例模块之前装入 require.cache（不 patch 模块导出）。
const servicePath = require.resolve(path.join(ROOT, 'src', 'platform', 'os', 'service'));
const instancePath = require.resolve(path.join(ROOT, 'src', 'domains', 'instance'));
const fakeProvider = {
  kind: 'test-double',
  supportsUnits: true,
  supportsTransient: true,
  daemonReload() { return true; },
  stopUnit() { return true; },
  resetFailed() { return true; },
  isUnitActive() { return false; },
  transientUnitFile() { return null; },
  cleanTransient() {},
  startTransient() { return true; },
};
require.cache[servicePath] = {
  id: servicePath,
  filename: servicePath,
  loaded: true,
  exports: {
    current: () => fakeProvider,
    CapabilityError: class CapabilityError extends Error {},
    kind: () => fakeProvider.kind,
    PLATFORM: process.platform,
  },
};
delete require.cache[instancePath];
const { InstanceManager } = require(instancePath);

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'inst-systemd-aside-'));

function makeMgr(systemdDir, events) {
  // systemdDir/events 必须在构造期注入，否则落回真实 ~/.config/systemd/user。
  return new InstanceManager({
    dir: path.join(tmpRoot, 'sup-' + Math.random().toString(36).slice(2)),
    logger: { info() {}, warn() {}, error() {} },
    systemdDir,
    systemdTemplatePath: path.join(systemdDir, 'dsh-web@.service'),
    events,
  });
}

function scenario() {
  const systemdDir = fs.mkdtempSync(path.join(tmpRoot, 'user-'));
  const template = path.join(systemdDir, 'dsh-web@.service');
  fs.writeFileSync(template, '[Unit]\nDescription=legacy\n');
  const userFile = template + '.disabled-by-lobox';
  const userBody = 'USER-OWNED-CONTENT-DO-NOT-DELETE\n';
  fs.writeFileSync(userFile, userBody);
  return { systemdDir, template, userFile, userBody };
}

function cleanup() {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  delete require.cache[servicePath];
  delete require.cache[instancePath];
}

try {
  const s = scenario();
  const mgr = makeMgr(s.systemdDir, { append() {} });

  const ok = mgr._prepareSystemd();
  check('让位动作返回 true（未抛错）', ok === true, String(ok));

  const stillThere = fs.existsSync(s.userFile);
  check('预置的同名文件未被删除（不得用 rmSync 连坐）', stillThere, stillThere ? '仍在' : '**已被删除**');
  if (stillThere) {
    check('预置文件内容逐字未变', fs.readFileSync(s.userFile, 'utf8') === s.userBody, 'ok');
  }

  check('原模板路径已不存在（已让位）', !fs.existsSync(s.template), String(fs.existsSync(s.template)));

  const asideFiles = fs.readdirSync(s.systemdDir).filter((f) => f.startsWith('dsh-web@.service.disabled-by-lobox-'));
  check('存在带时间戳的让位文件', asideFiles.length === 1, asideFiles.join(', '));
  if (asideFiles.length === 1) {
    const asidePath = path.join(s.systemdDir, asideFiles[0]);
    check('让位文件内容 == 原模板内容（没丢数据）',
      fs.readFileSync(asidePath, 'utf8') === '[Unit]\nDescription=legacy\n', 'ok');
  }

  const before = fs.readdirSync(s.systemdDir).sort().join(',');
  mgr._prepareSystemd();
  check('模板已让位后再调用无新副作用',
    fs.readdirSync(s.systemdDir).sort().join(',') === before, before);

  const s2 = scenario();
  const mgr2 = makeMgr(s2.systemdDir);
  const asideOf = () => fs.readdirSync(s2.systemdDir).filter((f) => f.startsWith('dsh-web@.service.disabled-by-lobox-'));
  mgr2._prepareSystemd();
  const firsts = asideOf();
  check('首次让位产生唯一命名的让位文件', firsts.length === 1, firsts.join(', '));
  const firstBody = fs.readFileSync(path.join(s2.systemdDir, firsts[0]), 'utf8');
  fs.writeFileSync(s2.template, '[Unit]\nDescription=second\n');
  mgr2._prepareSystemd();
  check('重名时首个让位文件未被覆盖，且改用新的唯一名',
    fs.readFileSync(path.join(s2.systemdDir, firsts[0]), 'utf8') === firstBody && asideOf().length === 2,
    asideOf().join(', '));
} finally {
  cleanup();
}

// ── 真实 provider 下的判据（不再借 OS 通道）───────────────────────────────
// 上面的假 provider 把 supportsUnits 置 true 才走得到让位逻辑；
// 真实服务控制器必须 **恒为 portable**，于是 _prepareSystemd 连门都不进：
// 既不 mkdir 用户级 systemd 目录，也不改动既有的 dsh-web@.service。
{
  // ⚠ 顶部 `const { InstanceManager }` 是**注入假 provider 时**取到的旧引用，
  //   直接用它会继续走让位逻辑 ⇒ 必须清缓存后重新 require，拿到绑定真实 provider 的新引用。
  delete require.cache[instancePath];
  delete require.cache[servicePath];
  const realSvc = require(path.join(ROOT, 'src', 'platform', 'os', 'service.js'));
  const realProvider = realSvc.current();
  const RealInstanceManager = require(instancePath).InstanceManager;
  check('真实 provider 恒为 portable（不借 systemd-run，Linux 有也不借）',
    realProvider.kind === 'portable', realProvider.kind);
  check('真实 provider 不支持 units ⇒ _prepareSystemd 门控直过',
    realProvider.supportsUnits === false, String(realProvider.supportsUnits));

  // ⚠ 上面的 cleanup() 已删掉 tmpRoot ⇒ 这里必须用**新的**临时根，否则 mkdtemp 直接抛 ENOENT。
  const tmpRoot3 = fs.mkdtempSync(path.join(os.tmpdir(), 'inst-real-provider-'));
  const systemdDir3 = fs.mkdtempSync(path.join(tmpRoot3, 'user-'));
  const template3 = path.join(systemdDir3, 'dsh-web@.service');
  fs.writeFileSync(template3, '[Unit]\nDescription=legacy\n');
  const before3 = fs.readdirSync(systemdDir3).sort().join(',');
  const mgr3 = new RealInstanceManager({
    dir: path.join(tmpRoot3, 'sup'),
    logger: { info() {}, warn() {}, error() {} },
    systemdDir: systemdDir3,
    systemdTemplatePath: template3,
    events: { append() {} },
  });
  const r3 = mgr3._prepareSystemd();
  check('真实 provider 下 _prepareSystemd 不产生任何让位文件（不碰 systemd 目录）',
    r3 === true && fs.readdirSync(systemdDir3).sort().join(',') === before3,
    'r=' + r3 + ' dir=' + fs.readdirSync(systemdDir3).sort().join(','));
  check('真实 provider 下原模板文件仍在（未被动过）',
    fs.existsSync(template3), String(fs.existsSync(template3)));
  try { fs.rmSync(tmpRoot3, { recursive: true, force: true }); } catch {}
}

const failed = results.filter((r) => !r);
console.log('\n结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
process.exit(failed.length ? 1 : 0);
