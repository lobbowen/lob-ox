#!/usr/bin/env node
'use strict';

// ---------------------------------------------------------------------------
// 令牌持久化：写后必须**收口权限**，超限必须**轮转而非截断**
//
// 缺陷（被测对象：src/platform/service/token/persist.js::appendByRotation）：
//   · appendFileSync 的 mode 仅对 O_CREAT 生效、对既有文件被忽略；若曾以 0644 落盘，每次轮换
//     都把明文令牌追加进**世界可读**文件（该令牌即可直连面板的会话凭据）。
//   · 轮转用「读 -> 写 -> 截断」：read 与 truncate 之间的跨进程追加行既进不了备份也被截断
//     抹掉（窗口期丢数据）。修法为原子改名抢占。
//
// 锁定不变量：T-a 既有宽权限文件写入后被收口为 0600（写后显式 chmod，不只靠 O_CREAT）·
//   T-b 新建文件也是 0600 且功能正常 · T-c 轮转：备份槽携带轮转前旧内容、窗口期并发追加
//   **不丢失**、本次新行落新文件。
//   **POSIX 权限位在 Windows 上不存在**（chmodSync 只能切换只读位，mode 恒 0666/0444），
//   故模式断言只在 POSIX 上执行并**显式打 SKIP**（不静默变绿）—— 这是夹具的平台限制，非产品缺陷。
// ---------------------------------------------------------------------------

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');

const results = [];
const check = (n, c, x) => {
  results.push(!!c);
  console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  <- ' + x : ''));
};

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'token-mode-'));
// 令牌持久化已随令牌组件目录化迁至 src/platform/service/token/persist.js（appendByRotation）
const { appendByRotation } = require(path.join(ROOT, 'src', 'platform', 'service', 'token', 'persist.js'));

const POSIX = process.platform !== 'win32';
if (!POSIX) console.log('SKIP 权限位断言（Windows 无 POSIX mode；chmodSync 仅切换只读位）');

// 场景 A：既有文件为 0644 -> 写入后必须收口到 0600
{
  const fp = path.join(TMP, 'token.log');
  fs.writeFileSync(fp, 'old-line\n');
  if (POSIX) fs.chmodSync(fp, 0o644);
  appendByRotation(fp, 'http://127.0.0.1:3080/?token=ABC');
  if (POSIX) check('T-a 写入既有 0644 文件后 mode 收口为 0600（旧实现仍 644，世界可读）',
    (fs.statSync(fp).mode & 0o777) === 0o600, (fs.statSync(fp).mode & 0o777).toString(8));
  check('T-a 令牌行确实追加（功能未受影响）',
    /token=ABC/.test(fs.readFileSync(fp, 'utf8')), 'ok');
}

// 场景 B：新建文件也必须 0600
{
  const fp2 = path.join(TMP, 'token-new.log');
  appendByRotation(fp2, 'http://127.0.0.1:3080/?token=NEW');
  if (POSIX) check('T-b 新建文件为 0600 且写入成功（跨平台功能）',
    (fs.statSync(fp2).mode & 0o777) === 0o600 && /token=NEW/.test(fs.readFileSync(fp2, 'utf8')),
    (fs.statSync(fp2).mode & 0o777).toString(8));
  else check('T-b 新建文件写入成功（Windows 无 POSIX 权限位）', /token=NEW/.test(fs.readFileSync(fp2, 'utf8')), 'ok');
}

// 场景 C（T-c）：轮转必须「原子改名抢占」而非「读->写->截断」（旧实现窗口期的跨进程追加行既进不了
//   备份也会被截断抹掉）。用「先持有旧 fd、轮转后再写」确定性复现该窗口：rename 语义下迟到行落进备份本体。
{
  const fpD = path.join(TMP, 'token-rotate.log');
  fs.writeFileSync(fpD, 'OLD-LINE http://127.0.0.1:3080/?token=OLD\n');
  const fdOld = fs.openSync(fpD, 'a'); // 模拟并发写者已打开的 fd
  const rD = appendByRotation(fpD, 'http://127.0.0.1:3080/?token=NEW', { maxBytes: 1 });
  check('T-c 前提：超限追加报告已轮转', rD.ok === true && rD.rotated === true, JSON.stringify(rD));
  fs.writeSync(fdOld, 'RACE-LINE http://127.0.0.1:3080/?token=RACE\n'); // 「窗口内」迟到追加
  fs.closeSync(fdOld);
  const bakAll = ['.bak-0', '.bak-1'].map((s) => { try { return fs.readFileSync(fpD + s, 'utf8'); } catch { return ''; } }).join('');
  const fpNow = fs.readFileSync(fpD, 'utf8');
  check('T-c 备份槽携带轮转前旧内容', /token=OLD/.test(bakAll), JSON.stringify(bakAll.slice(0, 120)));
  check('T-c 轮转窗口期的并发追加不丢失（旧实现此断言必红：截断抹掉）',
    /token=RACE/.test(bakAll + fpNow), 'bak+fp=' + String(bakAll + fpNow).replace(/\n/g, '|'));
  check('T-c 轮转后本次新行落入目标新文件', /token=NEW/.test(fpNow), JSON.stringify(fpNow));
}

fs.rmSync(TMP, { recursive: true, force: true });
const failed = results.filter((r) => !r);
console.log('\n结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
process.exit(failed.length ? 1 : 0);
