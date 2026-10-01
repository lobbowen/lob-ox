#!/usr/bin/env node
'use strict';


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
  const userFile = template + '.disabled-by-dsh';
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

  const asideFiles = fs.readdirSync(s.systemdDir).filter((f) => f.startsWith('dsh-web@.service.disabled-by-dsh-'));
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
  const asideOf = () => fs.readdirSync(s2.systemdDir).filter((f) => f.startsWith('dsh-web@.service.disabled-by-dsh-'));
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

const failed = results.filter((r) => !r);
console.log('\n结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
process.exit(failed.length ? 1 : 0);
