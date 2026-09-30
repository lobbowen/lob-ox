#!/usr/bin/env node
'use strict';

// ---------------------------------------------------------------------------
// 破坏性操作防误伤门禁—— 源于一次**真实事故**
//
// ## 事故
//   做凭据门禁的**注入验证**时，先注入了「移除 DSH_CRED_DIR」以破坏夹具模式；
//   测试脚本随后的 `cred.sh put` 便**回落到真机库根**执行，把 16B 测试串
//   写进 kernel-advgyxqamf.pat，**覆盖了 93B 真令牌**（不可恢复）。
//   又因迁移时旧路径是符号链接，覆盖立即生效、无第二份副本。
//
// ## 教训（可推广的规律）
//   1) 任何**破坏性**子命令都必须对「真机」默认拒绝，而不是默默执行；
//   2) 测试夹具必须与真机**结构隔离**，且隔离失效时要**失败**而不是降级；
//   3) 覆盖前必须留旧值备份，使操作**可逆**；
//   4) 注入验证本身要选**非破坏性**的注入点。
//
// ## 锁定不变量
//   W-1  cred.sh 的 put 在真机库上默认拒绝（需显式确认）
//   W-2  真机库上未带确认执行 put -> exit 2 且**文件字节不变**
//   W-3  写入前会备份旧值（.bak-<时间戳>）
//   W-4  夹具模式（DSH_CRED_DIR）仍可正常写入
// ---------------------------------------------------------------------------

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const ROOT = path.join(__dirname, '..');
const CRED_SH = path.join(ROOT, 'release', 'scripts', 'cred.sh');

const results = [];
const check = (n, c, x) => {
  results.push(!!c);
  console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  <- ' + x : ''));
};

const sha = (p) => { try { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').slice(0, 16); } catch { return null; } };

// -- W-1/W-2/W-3：真机库保护（用 DSH_REAL_HOME 把「真机库」指向临时目录）--
//  关键设计：**不依赖真机库的状态，也不复制/改写脚本**。
//   cred.sh 的「真机库」= dsh_real_home()/develop/.credentials；
//   _npm-auth.sh 支持 DSH_REAL_HOME 覆盖。
//   故设 DSH_REAL_HOME=<tmp> 即可在任意宿主确定性验证真机保护，且**完全不动真实凭据**。
{
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'realsim-'));
  fs.chmodSync(T, 0o700);
  const fakeHome = path.join(T, 'fakehome');
  const fakeReal = path.join(fakeHome, 'develop', '.credentials');
  fs.mkdirSync(fakeReal, { recursive: true, mode: 0o700 });
  const kf = path.join(fakeReal, 'k.pat');
  fs.writeFileSync(kf, 'original-secret-value');
  fs.chmodSync(kf, 0o600);
  fs.writeFileSync(path.join(fakeReal, 'index.json'), JSON.stringify({
    version: 1, storeDir: fakeReal, homeNote: 'x', rules: ['a', 'b', 'c', 'd'],
    entries: [{ name: 'kernel', kind: 'github-pat', account: 'x', file: kf, verify: { method: 'file' }, status: 'active' }],
    history: [],
  }));
  fs.chmodSync(path.join(fakeReal, 'index.json'), 0o600);

  const runReal = (args, env) => {
    try {
      const out = execFileSync('bash', [CRED_SH].concat(args), {
        encoding: 'utf8', timeout: 60000,
        env: Object.assign({}, process.env, { DSH_REAL_HOME: fakeHome }, env || {}),
      });
      return { code: 0, out: String(out) };
    } catch (e2) {
      return { code: (e2 && e2.status) || 1, out: String((e2 && e2.stdout) || '') + String((e2 && e2.stderr) || '') };
    }
  };
  const before = sha(kf);
  const rDeny = runReal(['put', 'kernel']);        // 无确认 —— 必须被拒
  const afterDeny = sha(kf);
  check('W-1 「真机库」上 put 无确认时被拒绝（exit 2）', rDeny.code === 2, 'exit=' + rDeny.code);
  check('W-2 被拒绝时凭据文件**字节未变**', before !== null && before === afterDeny, before + ' vs ' + afterDeny);
  check('W-1 拒绝信息解释原因并给出两种正确用法',
    /显式确认/.test(rDeny.out) && /DSH_CRED_DIR/.test(rDeny.out), 'ok');
  // 带确认 -> 应成功且**自动备份旧值**
  let rAllow = { code: -1, out: '' };
  try {
    const out = execFileSync('bash', ['-c', 'printf %s rotated-value | bash "$0" put kernel', CRED_SH], {
      encoding: 'utf8', timeout: 60000,
      env: Object.assign({}, process.env, { DSH_REAL_HOME: fakeHome, DSH_CRED_ALLOW_OVERWRITE: '1', DSH_CRED_FORCE: '1' }),
    });
    rAllow = { code: 0, out: String(out) };
  } catch (e3) { rAllow = { code: (e3 && e3.status) || 1, out: String((e3 && e3.stderr) || '') }; }
  const baks = fs.readdirSync(fakeReal).filter((f) => f.includes('.bak-'));
  check('W-3 覆盖前自动备份旧值（.bak-<时间戳>）', baks.length >= 1, baks.join(', ') || '(无备份)');
  check('W-3 备份内容 = 覆盖前的原值', baks.length >= 1
    && fs.readFileSync(path.join(fakeReal, baks[0]), 'utf8') === 'original-secret-value', 'ok');
  check('W-4 显式确认后写入成功（新值生效）',
    fs.readFileSync(kf, 'utf8') === 'rotated-value', fs.readFileSync(kf, 'utf8'));
  fs.rmSync(T, { recursive: true, force: true });
}
{
  //  夹具模式（DSH_CRED_DIR）必须仍可写入：真机保护不得误伤测试隔离路径（W-4）。
  //  这里只判「写入生效 + 覆盖前留备份」的行为面，不再重跑一遍 W-2/W-3 同判据。
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'wbak-'));
  const kf = path.join(T, 'a.pat');
  fs.writeFileSync(kf, 'old-value', { mode: 0o600 });
  fs.writeFileSync(path.join(T, 'index.json'), JSON.stringify({
    version: 1, storeDir: T, rules: [],
    entries: [{ name: 'a', kind: 'github-pat', file: kf, status: 'active' }], history: [],
  }), { mode: 0o600 });
  try {
    execFileSync('bash', ['-c', 'printf %s new | bash "$0" put a', CRED_SH],
      { encoding: 'utf8', env: Object.assign({}, process.env, { DSH_CRED_DIR: T }) });
  } catch (err) { /* 断言判定 */ }
  check('W-4 夹具模式仍可正常写入（不被真机保护阻断）且覆盖前留备份',
    fs.readFileSync(kf, 'utf8') === 'new' && fs.readdirSync(T).some((f) => f.includes('.bak-')));
  fs.rmSync(T, { recursive: true, force: true });
}

const failed = results.filter((r) => !r);
console.log(String.fromCharCode(10) + '结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
process.exit(failed.length ? 1 : 0);
