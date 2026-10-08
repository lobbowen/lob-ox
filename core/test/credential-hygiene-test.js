#!/usr/bin/env node
'use strict';


const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const ROOT = path.join(__dirname, '..');
const CRED_SH = path.join(ROOT, 'release', 'scripts', 'cred.sh');

const results = [];
let skipped = 0;
// Windows 无 POSIX 权限位（chmod 只切换只读位，mode 常为 666）：权限语义断言必须平台自感知。
const IS_POSIX = process.platform !== 'win32';
const check = (n, c, x) => {
  results.push(!!c);
  console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  <- ' + x : ''));
};
/**
 * 环境不具备条件时**显式跳过**，不得写成 `!X || ...` 的恒真断言
 * （R16：判据从未执行却计入 PASS，即假绿）。
 */
const skip = (n, why) => {
  skipped += 1;
  console.log('SKIP ' + n + '  <- ' + why);
};
const TOKEN_RE = /github_pat_[A-Za-z0-9_]{20,}|ghp_[A-Za-z0-9]{20,}/;
const modeOf = (p) => { try { return (fs.statSync(p).mode & 0o777).toString(8).padStart(3, '0'); } catch { return null; } };

// 先抹平宿主确认位再叠加 envExtra：残留的 DSH_CRED_ALLOW_OVERWRITE / DSH_CRED_BACKUP_DIR 会让「应被拒绝」的负例因环境而变绿。
function runCredIn(dir, args, input, envExtra) {
  const base = {
    DSH_CRED_DIR: dir,
    DSH_CRED_ALLOW_OVERWRITE: '',
    DSH_CRED_FORCE: '',
    DSH_CRED_BACKUP_DIR: '',
  };
  try {
    const out = execFileSync('bash', [CRED_SH].concat(args), {
      encoding: 'utf8', timeout: 60000, input: input == null ? '' : input,
      env: Object.assign({}, process.env, base, envExtra || {}),
    });
    return { code: 0, out: String(out) };
  } catch (e) {
    return { code: (e && e.status) || 1, out: String((e && e.stdout) || '') + String((e && e.stderr) || '') };
  }
}

function fixture(dir, opts) {
  const o = opts || {};
  const kf = path.join(dir, 'kernel-test.pat');
  const idxPath = path.join(dir, 'index.json');
  fs.mkdirSync(dir, { recursive: true });
  fs.chmodSync(dir, 0o700);
  fs.writeFileSync(kf, 'dummy-not-a-real-token');
  fs.chmodSync(kf, 0o600);
  fs.writeFileSync(idxPath, JSON.stringify({
    version: 1, storeDir: dir, homeNote: 'x', rules: ['a', 'b', 'c', 'd'], history: [],
    entries: [{ name: 'kernel', kind: 'github-pat', account: 'x', file: kf, verify: { method: 'file' }, status: o.kernelMissing ? 'missing' : 'active' }],
  }, null, 2));
  fs.chmodSync(idxPath, 0o600);
  return { dir: dir, idxPath: idxPath, kf: kf };
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'credgate-'));

{
  const d1 = path.join(TMP, 'ok');
  fixture(d1);
  const r1 = runCredIn(d1, ['doctor']);
  check('D-1 夹具库齐全时 cred.sh doctor 通过（退出 0）', r1.code === 0, 'exit=' + r1.code);

  const d2 = path.join(TMP, 'loose');
  const f2 = fixture(d2);
  fs.chmodSync(f2.kf, 0o644);
  const r2 = runCredIn(d2, ['doctor']);
  check('D-2 库内文件权限过宽（0644）-> doctor 失败（POSIX）/ Windows 跳过',
    IS_POSIX ? r2.code !== 0 : true,
    IS_POSIX ? 'exit=' + r2.code : 'Windows 无 POSIX 权限位');

  const d3 = path.join(TMP, 'missing');
  fixture(d3, { kernelMissing: true });
  const r3 = runCredIn(d3, ['doctor']);
  check('D-3 条目 status=missing -> doctor 失败（缺项可见）', r3.code !== 0, 'exit=' + r3.code);

  const d4 = path.join(TMP, 'outside');
  const f4 = fixture(d4);
  const j4 = JSON.parse(fs.readFileSync(f4.idxPath, 'utf8'));
  j4.entries[0].file = path.join(TMP, 'home', '.dsh', 'supervisor', 'instances', 'inst-1', 'data', '.dsh', 'attachments', 'x', 'gh_token.txt');
  fs.writeFileSync(f4.idxPath, JSON.stringify(j4, null, 2));
  const r4 = runCredIn(d4, ['doctor']);
  check('D-4 条目指向 ephemeral 附件路径 -> doctor 失败', r4.code !== 0, 'exit=' + r4.code);

  const r5 = runCredIn(d1, ['list']);
  const r5b = runCredIn(d1, ['path', 'kernel']);
  const absPath = /^([A-Za-z]:[\\/]|\/)/.test(r5b.out.trim());
  const r5c = runCredIn(d1, ['get', 'kernel']);
  const r5d = runCredIn(d1, ['get', 'nonexistent']);
  check('D-5 list 输出条目名与状态、path 输出库内绝对路径；get 返回文件内容、未知条目非零退出',
    /kernel/.test(r5.out) && /active/.test(r5.out) && /kernel-test[.]pat/.test(r5b.out) && absPath
    && r5c.out.trim() === 'dummy-not-a-real-token' && r5d.code !== 0, r5b.out.trim());

  const d6 = path.join(TMP, 'put');
  fixture(d6, { kernelMissing: true });
  runCredIn(d6, ['put', 'kernel'], 'new-secret-value');
  const kf6 = path.join(d6, 'kernel-test.pat');
  check('D-6 put 写入文件且权限 0600（POSIX）/ Windows 仅断言写入',
    fs.existsSync(kf6) && (IS_POSIX ? modeOf(kf6) === '600' : true),
    IS_POSIX ? String(modeOf(kf6)) : 'Windows 无 POSIX 权限位');
  check('D-6 put 后该条目 status 变为 active，且 doctor 通过（缺项已消）',
    JSON.parse(fs.readFileSync(path.join(d6, 'index.json'), 'utf8')).entries[0].status === 'active'
    && runCredIn(d6, ['doctor']).code === 0, 'ok');

  const d7 = path.join(TMP, 'put-empty');
  const f7 = fixture(d7, { kernelMissing: true });
  fs.writeFileSync(f7.kf, 'OLD-VALUE');
  const r7 = runCredIn(d7, ['put', 'kernel'], '');
  check('D-7 空 stdin 的 put 被拒（非零退出），目标文件未被截断、清单状态不变',
    r7.code !== 0 && fs.readFileSync(f7.kf, 'utf8') === 'OLD-VALUE'
    && JSON.parse(fs.readFileSync(f7.idxPath, 'utf8')).entries[0].status === 'missing', 'exit=' + r7.code);
  check('D-7 不留 .tmp / .bak 残留（校验与备份都发生在动目标之前）',
    fs.readdirSync(d7).filter((x) => x.indexOf('.tmp.') >= 0 || x.indexOf('.bak-') >= 0).length === 0,
    fs.readdirSync(d7).join(','));

  const r8 = runCredIn(d7, ['put', 'kernel'], '\n  \t \n');
  check('D-8 全空白 stdin 同样被拒（同一 fail-closed 判据的第二输入）且原值仍在',
    r8.code !== 0 && fs.readFileSync(f7.kf, 'utf8') === 'OLD-VALUE',
    'exit=' + r8.code);

  const d9 = path.join(TMP, 'put-backup');
  const f9 = fixture(d9);
  fs.writeFileSync(f9.kf, 'OLD-VALUE');
  const r9ok = runCredIn(d9, ['put', 'kernel'], 'NEW-VALUE');
  const baks9 = fs.readdirSync(d9).filter((x) => x.indexOf('.bak-') >= 0);
  const bak9p = baks9.length === 1 ? path.join(d9, baks9[0]) : null;
  check('D-9 覆盖写入成功（目标为新值），且只留一个备份：名 <文件>.bak-<14位时间戳>、内容 = 旧值',
    r9ok.code === 0 && fs.readFileSync(f9.kf, 'utf8') === 'NEW-VALUE' && !!bak9p
    && /^kernel-test[.]pat[.]bak-\d{14}$/.test(baks9[0])
    && fs.readFileSync(bak9p, 'utf8') === 'OLD-VALUE', baks9.join(',') || '(无备份)');
  // 权限语义只在 POSIX 成立；Windows 必须 skip，不得写成 `!IS_POSIX || ...`（恒真假绿，R16）。
  if (IS_POSIX) {
    check('D-9 备份权限 0600（POSIX）',
      !!bak9p && modeOf(bak9p) === '600', bak9p ? String(modeOf(bak9p)) : '(无备份)');
  } else {
    skip('D-9 备份权限 0600', 'Windows 无 POSIX 权限位');
  }

  const r10a = runCredIn(d1, ['backup'], '');
  check('D-10 不给目标目录 -> 拒绝且不用默认值', r10a.code !== 0, 'exit=' + r10a.code);
  const inInst = path.join(TMP, 'inst-root', 'supervisor', 'instances', 'inst-1', 'bak');
  const r10b = runCredIn(d1, ['backup', inInst], '');
  const r10w = runCredIn(d1, ['backup', 'X:\\ephemeral\\supervisor\\instances\\inst-9\\bak'], '');
  check('D-10 目标在实例目录内（POSIX 与反斜杠两种形态）-> 拒绝且不创建目标目录',
    r10b.code !== 0 && !fs.existsSync(inInst) && r10w.code !== 0, 'exit=' + r10b.code + '/' + r10w.code);
  const noextBak = path.join(d1, 'git-credentials');
  fs.writeFileSync(noextBak, 'https://x-access-token:dummy-not-a-real-token@github.com');
  fs.chmodSync(noextBak, 0o600);
  const okBak = path.join(TMP, 'persist-bak');
  const r10c = runCredIn(d1, ['backup', okBak], '');
  const outs = r10c.code === 0 ? fs.readdirSync(okBak) : [];
  const sub = outs.length ? path.join(okBak, outs[0]) : null;
  check('D-10 合法目标 -> 带时间戳副本目录，含清单与每个凭据文件（含无扩展名者，内容一致），输出不回显令牌值',
    outs.length === 1 && /^dsh-credentials-\d{14}$/.test(outs[0] || '')
    && !!sub && fs.existsSync(path.join(sub, 'index.json'))
    && fs.existsSync(path.join(sub, 'kernel-test.pat'))
    && fs.existsSync(path.join(sub, 'git-credentials'))
    && fs.readFileSync(path.join(sub, 'git-credentials'), 'utf8') === 'https://x-access-token:dummy-not-a-real-token@github.com'
    && !/dummy-not-a-real-token/.test(r10c.out),
    sub ? fs.readdirSync(sub).join(',') : '无产出');
  // 同上：Windows 必须 skip，不得恒真（R16）。
  if (IS_POSIX) {
    check('D-10 副本目录 0700、副本文件 0600（POSIX）',
      !!sub && modeOf(sub) === '700' && modeOf(path.join(sub, 'kernel-test.pat')) === '600'
        && modeOf(path.join(sub, 'git-credentials')) === '600',
      sub ? modeOf(sub) + '/' + modeOf(path.join(sub, 'kernel-test.pat')) : '(无产出)');
  } else {
    skip('D-10 副本目录/文件权限', 'Windows 无 POSIX 权限位');
  }

  const r11 = runCredIn(d1, ['frobnicate'], '');
  const r12 = runCredIn(d1, ['put', 'nope'], 'x');
  check('D-11 未知子命令 -> exit 1（用法错误）；D-12 put 未知条目 -> 拒绝且不落任何文件',
    r11.code === 1 && r12.code !== 0, 'exit=' + r11.code + '/' + r12.code);

  const d13 = path.join(TMP, 'leaky-index');
  const f13 = fixture(d13);
  const j13 = JSON.parse(fs.readFileSync(f13.idxPath, 'utf8'));
  j13.entries[0].value = 'github_pat_' + 'A'.repeat(30);
  fs.writeFileSync(f13.idxPath, JSON.stringify(j13, null, 2));
  const r13 = runCredIn(d13, ['doctor']);
  check('D-13 清单只存引用：清单含令牌值 -> doctor 失败（夹具在 tmp，不进 S-1 扫描面）',
    r13.code !== 0, 'exit=' + r13.code);

  const d14 = path.join(TMP, 'perm-noext');
  fixture(d14);
  const noext = path.join(d14, 'github-pat');
  fs.writeFileSync(noext, 'dummy-not-a-real-token');
  fs.chmodSync(noext, 0o644);
  const r14 = runCredIn(d14, ['doctor']);
  check('D-14 无扩展名凭据文件权限过宽 -> doctor 判红（不得按扩展名通配）',
    IS_POSIX ? (r14.code !== 0) : true,
    IS_POSIX ? 'exit=' + r14.code : 'Windows 无 POSIX 权限位');
  fs.chmodSync(noext, 0o600);
  const r14b = runCredIn(d14, ['doctor']);
  check('D-14 同一文件收回到 0600 后 doctor 转绿（判据非单向）',
    IS_POSIX ? (r14b.code === 0) : true,
    IS_POSIX ? 'ok' : 'Windows 无 POSIX 权限位');

  const d15 = path.join(TMP, 'nameless');
  const f15 = fixture(d15);
  const j15 = JSON.parse(fs.readFileSync(f15.idxPath, 'utf8'));
  delete j15.entries[0].name;
  fs.writeFileSync(f15.idxPath, JSON.stringify(j15, null, 2));
  const r15 = runCredIn(d15, ['doctor']);
  const d15c = path.join(TMP, 'dupname');
  const f15c = fixture(d15c);
  const j15c = JSON.parse(fs.readFileSync(f15c.idxPath, 'utf8'));
  j15c.entries.push({ name: 'kernel', kind: 'npm-token', account: 'x', file: f15c.kf, status: 'active' });
  fs.writeFileSync(f15c.idxPath, JSON.stringify(j15c, null, 2));
  const r15c = runCredIn(d15c, ['doctor']);
  const r15b = runCredIn(d15, ['path', 'kernel']);
  check('D-15 缺 name / name 重复 -> doctor 均判红，且缺 name 时 path 确实失效（不可达是真实后果）',
    r15.code !== 0 && r15c.code !== 0 && r15b.code !== 0, 'exit=' + r15.code + '/' + r15c.code + '/' + r15b.code);

  const d16 = path.join(TMP, 'kind-outside');
  const f16 = fixture(d16);
  const j16 = JSON.parse(fs.readFileSync(f16.idxPath, 'utf8'));
  j16.entries[0].kind = 'npm-token';
  j16.entries[0].file = path.join(TMP, 'elsewhere', 'npm-token');
  fs.writeFileSync(f16.idxPath, JSON.stringify(j16, null, 2));
  const r16 = runCredIn(d16, ['doctor']);
  check('D-16 非 github-pat kind 的条目指向库外 -> doctor 判红（不得按 kind 过滤）',
    r16.code !== 0, 'exit=' + r16.code);

  const r17 = runCredIn(d1, ['verify', 'nope']);
  const r17b = runCredIn(d1, ['verify', 'kernel']);
  check('D-17 verify 未知条目 -> 非零退出；无 API 打点的条目如实说明并退出 0',
    r17.code !== 0 && r17b.code === 0, 'exit=' + r17.code + '/' + r17b.code);
}

{
  const exts = ['.js', '.json', '.md', '.sh', '.yml', '.yaml', '.txt', '.rs', '.ts', '.tsx'];
  const hits = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!exts.includes(path.extname(e.name))) continue;
      let txt = '';
      try { txt = fs.readFileSync(p, 'utf8'); } catch { continue; }
      if (TOKEN_RE.test(txt)) hits.push(path.relative(ROOT, p));
    }
  };
  walk(ROOT);
  check('S-1 仓库工作树内无令牌值', hits.length === 0, hits.length ? hits.join(', ') : '未发现');
}


fs.rmSync(TMP, { recursive: true, force: true });
const failed = results.filter((r) => !r);
console.log(String.fromCharCode(10) + '结果: ' + (results.length - failed.length) + ' passed, '
  + failed.length + ' failed, ' + skipped + ' skipped');
process.exit(failed.length ? 1 : 0);
