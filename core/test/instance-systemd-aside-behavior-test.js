#!/usr/bin/env node
'use strict';

// systemd 模板「让位」不得删除任何已有文件：让位目标名带 epoch 时间戳（必要时加序号）-> 天然唯一 ->
//   无需先 rmSync。行为级断言（真实调用 _prepareSystemd()）：预置同名文件仍在且字节不变 / 原模板已移走 /
//   让位目标内容 == 原模板。注入方式：require.cache 在加载实例模块**之前**装入假 service（不 patch 模块导出）。

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const ROOT = path.join(__dirname, '..');

const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  ← ' + x : '')); };

// -- 注入假 service Provider（必须在 require 实例模块**之前**）--
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
  //  域拆分后 systemdDir/events 必须在**构造期**注入（组装根持有 ctx，单实例字段后置赋值不再生效）。
  //   否则会落回真实 ~/.config/systemd/user —— 本测试绝不允许触碰开发机 systemd 配置。
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
  // 用户/历史遗留的**同名文件**：让位绝不删它。
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

  // 1) 核心断言：预置的同名文件必须**仍在且内容不变**
  const stillThere = fs.existsSync(s.userFile);
  check('预置的同名文件未被删除（旧实现的 rmSync 会删掉它）', stillThere, stillThere ? '仍在' : '**已被删除**');
  if (stillThere) {
    check('预置文件内容逐字未变', fs.readFileSync(s.userFile, 'utf8') === s.userBody, 'ok');
  }

  // 2) 模板已被移走
  check('原模板路径已不存在（已让位）', !fs.existsSync(s.template), String(fs.existsSync(s.template)));

  // 3) 让位目标存在、内容 == 原模板内容、且名带时间戳
  const asideFiles = fs.readdirSync(s.systemdDir).filter((f) => f.startsWith('dsh-web@.service.disabled-by-dsh-'));
  check('存在带时间戳的让位文件', asideFiles.length === 1, asideFiles.join(', '));
  if (asideFiles.length === 1) {
    const asidePath = path.join(s.systemdDir, asideFiles[0]);
    check('让位文件内容 == 原模板内容（没丢数据）',
      fs.readFileSync(asidePath, 'utf8') === '[Unit]\nDescription=legacy\n', 'ok');
  }

  // 4) 再跑一次：模板已不在 -> 不再让位、也不该动任何文件（幂等、无副作用）
  const before = fs.readdirSync(s.systemdDir).sort().join(',');
  mgr._prepareSystemd();
  check('模板已让位后再调用无新副作用',
    fs.readdirSync(s.systemdDir).sort().join(',') === before, before);

  // 5) 让位目标重名时改用新的唯一名（绝不覆盖已有文件）—— 不钉命名形态与时钟：
  //    实现改用 pid/uuid/序号后缀同样为真，被覆盖才是红。
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
