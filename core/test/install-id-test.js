#!/usr/bin/env node
'use strict';


const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  <- ' + x : '')); };

const POSIX = process.platform !== 'win32';

// 隔离变量必须用 DSH_SUPERVISOR_HOME（与 test/_preload.js 同口径）：只设 XDG_STATE_HOME 会看似隔离而实检真实状态根。
function runIn(tmp, body, extraEnv) {
  const env = Object.assign({}, process.env, { DSH_SUPERVISOR_HOME: tmp, DSH_CANARY_ID: '' }, extraEnv || {});
  delete env.XDG_STATE_HOME; // 避免与 DSH_SUPERVISOR_HOME 语义混淆（后者是权威）
  return execFileSync(process.execPath, ['-e', body], { cwd: ROOT, env, encoding: 'utf8' });
}
const ID_PATH_PING = "const m = require('./src/platform/service/install-id');"
  + " process.stdout.write(JSON.stringify(m.installIdPath()));";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-installid-'));

{
  const out = runIn(tmp, `
    const m = require('./src/platform/service/install-id');
    const a = m.readInstallId();
    m._resetCache();
    const b = m.readInstallId();
    // 路径**由被测代码自己报**（而不是测试硬拼）——否则"路径口径"这一断言会变成
    //   "测试假设"的自证（本仓禁忌：断言必须检验实现，不能检验测试自己的假设）。
    process.stdout.write(JSON.stringify({ a, b, fp: m.installIdPath() }));
  `);
  const { a, b, fp } = JSON.parse(out);
  check('ID-1 首次调用生成 UUID v4 并落盘', !!a && a.source === 'created' && /^[0-9a-f-]{36}$/.test(a.id), JSON.stringify(a));
  check('ID-2 幂等：再次调用拿到同一个值（不漂移）', !!b && b.source === 'file' && b.id === a.id, JSON.stringify({ a: a && a.id, b: b && b.id }));
  check('ID-3a 落盘位置在隔离状态根内（不污染真实状态根）', String(fp).startsWith(tmp), fp);
  if (POSIX && fs.existsSync(fp)) {
    const mode = fs.statSync(fp).mode & 0o777;
    check('ID-3b 落盘权限 0600', mode === 0o600, mode.toString(8));
  } else {
    console.log('SKIP ID-3b 权限位断言（Windows 无 POSIX mode 或文件不存在）');
  }
}

{
  const out = runIn(tmp, `
    const m = require('./src/platform/service/install-id');
    process.stdout.write(JSON.stringify(m.readInstallId()));
  `, { DSH_CANARY_ID: '  550e8400-e29b-41d4-a716-446655440000  ' });
  const r = JSON.parse(out);
  check('ID-4 环境变量覆盖优先且 trim', r && r.source === 'env' && r.id === '550e8400-e29b-41d4-a716-446655440000', JSON.stringify(r));
}

{
  const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-installid-bad-'));
  const fp = JSON.parse(runIn(tmp2, ID_PATH_PING));
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, 'not-a-uuid\n');
  const out = runIn(tmp2, `
    const m = require('./src/platform/service/install-id');
    process.stdout.write(JSON.stringify({ r: m.readInstallId(), after: require('node:fs').readFileSync(m.installIdPath(), 'utf8') }));
  `);
  const { r, after } = JSON.parse(out);
  check('ID-5 内容非法时返回 null 且**不覆盖**原文件（防漂移）',
    r === null && after.trim() === 'not-a-uuid', JSON.stringify({ r, after: after.trim() }));
  fs.rmSync(tmp2, { recursive: true, force: true });
}

{
  const tmp3 = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-installid-ro-'));
  const fp3 = JSON.parse(runIn(tmp3, ID_PATH_PING));
  const rootDir = path.dirname(fp3);
  fs.mkdirSync(rootDir, { recursive: true });
  if (POSIX) fs.chmodSync(rootDir, 0o500);
  let r = null;
  try {
    r = JSON.parse(runIn(tmp3, `
      const m = require('./src/platform/service/install-id');
      process.stdout.write(JSON.stringify(m.readInstallId()));
    `));
  } catch (e) {
    r = { threw: true };
  }
  if (POSIX) {
    check('ID-6 写盘失败时不返回临时值（返回 null，行为可复现）', r === null, JSON.stringify(r));
    fs.chmodSync(rootDir, 0o700);
  } else {
    console.log('SKIP ID-6 只读目录断言（Windows 不适用）');
  }
  fs.rmSync(tmp3, { recursive: true, force: true });
}

fs.rmSync(tmp, { recursive: true, force: true });

const failed = results.filter((r) => !r);
console.log(String.fromCharCode(10) + '结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
process.exit(failed.length ? 1 : 0);
