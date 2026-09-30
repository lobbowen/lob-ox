#!/usr/bin/env node
'use strict';

// ---------------------------------------------------------------------------
// 测试链 runner —— 读 test/manifest.js，逐条起独立子进程执行。
//
// 为什么仍是「一条一个进程」而不是 in-process 串联：链中测试普遍以 process.exit() 收尾，
//   in-process 跑会把整条链在第一道退出码处掐断。子进程形态同时保留了
//   _preload.js 的按进程隔离（DSH_SUPERVISOR_HOME 每个测试一份临时状态根）。
//
// 用法：
//   node test/_runner.js                  # 全链（CI test job 用）
//   node test/_runner.js --tier=L2       # 只跑依赖真实宿主 OS 的那批（产线矩阵腿用）
//   node test/_runner.js --only=a,b      # 只跑指定条目（本地排查/复现用）
//   node test/_runner.js --fail-fast     # 首个红点即停（默认跑完并汇总全部红点）
//
// 为什么默认不短路：`&&` 巨链的首个红点会截断其后全部条目，于是「本轮只报 N 条红」
//   不代表其余已绿 —— 排障者只能反复推 CI 复算。每条本就是独立子进程，
//   跑完不改变任何判定，红点台账因此完整。
//
// 输出末尾的 SKIP 台账：本宿主不该跑而被跳过的 L2 条目，以及被标了 skip-of-platform
//   的实跑文件（由 test 自行打印 SKIP 行）。
//   ⚠️ 2026-10-01：原先"SKIP 不等于通过、由 test-chain-completeness 判某平台在该跑的项上
//   全跳 = 红"这条执法**已随门禁整体拆除**（该门禁移至 C:\work\_gate_backup）
//   ⇒ **现在 SKIP 就是跳过，没有任何机制会把它记成缺口**。这是有意的。
// ---------------------------------------------------------------------------

const path = require('node:path');
const { spawnSync } = require('node:child_process');
const MANIFEST = require(path.join(__dirname, 'manifest.js'));

const argv = process.argv.slice(2);
const flag = (name, dflt) => {
  const hit = argv.find((a) => a.startsWith('--' + name + '='));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const has = (name) => argv.indexOf('--' + name) >= 0;

const TIER = flag('tier', 'all');
const ONLY = flag('only', '').split(',').map((s) => s.trim()).filter(Boolean);
const KEEP_GOING = !has('fail-fast');
const ROOT = path.join(__dirname, '..');
// 必须相对（与旧 && 链的字面量一致）：子进程 cmdline 会被被测层当作归属锚点读回来。
//   绝对路径把仓库检出目录名写进每条 cmdline，而 src/app/main/signals.js 的接管判据
//   含「命令行出现过 dsh」这种子串匹配 —— 测试进程就被守卫认成受管 DSH 并 SIGTERM
//   （smoke 的端口占用用例实证：改回相对后同一条判定不再触发）。
const PRELOAD = './test/_preload.js';

// tier=all 不按宿主过滤（见 manifest.select 注释）；--tier=L2 才按当前宿主筛。
let picked = MANIFEST.select(TIER === 'os' ? 'L2' : TIER, process.platform);
if (ONLY.length) {
  const norm = (f) => path.basename(f);
  const want = new Set(ONLY.map(norm));
  const known = new Set(MANIFEST.chain().map(norm));
  const bogus = ONLY.filter((o) => !known.has(o));
  if (bogus.length) {
    console.error('::error::--only 含未登记条目: ' + bogus.join(', ') + '（先加进 test/manifest.js）');
    process.exit(2);
  }
  picked = picked.filter((e) => want.has(norm(e.file)));
}

const results = [];
let firstFail = 0;
for (const entry of picked) {
  const started = Date.now();
  const r = spawnSync(process.execPath, ['-r', PRELOAD, entry.file], {
    cwd: ROOT, stdio: 'inherit', windowsHide: true,
  });
  const code = r.status === null ? -1 : r.status;
  // status=null 只说明「被子进程收到的信号打死」，不记信号就等于没记 ——
  //   红点会退化成「它挂了」，排障只能再推一轮 CI 猜。
  const why = r.status === null ? 'signal=' + (r.signal || '?') + (r.error ? ' error=' + r.error.code : '') : 'exit ' + r.status;
  results.push({ file: entry.file, tier: entry.tier, code, why, ms: Date.now() - started });
  if (code !== 0) {
    if (!firstFail) firstFail = code === -1 ? 1 : code;
    if (!KEEP_GOING) break;
  }
}

const failed = results.filter((x) => x.code !== 0);
const totalMs = results.reduce((s, x) => s + x.ms, 0);
console.log('');
console.log('== runner 台账 ==');
console.log('  tier=' + TIER + ' 宿主=' + process.platform + ' 已跑=' + results.length +
  ' 失败=' + failed.length + ' 累计实耗=' + Math.round(totalMs / 1000) + 's');
for (const f of failed) console.log('  FAIL ' + f.file + ' (' + f.why + ')');
const skipped = TIER === 'all' ? [] : MANIFEST.gaps(process.platform);
if (skipped.length) {
  console.log('  本平台未跑（登记表标了别的宿主）的 L2 条目 ' + skipped.length + ' 个:');
  for (const s of skipped) console.log('    SKIP ' + s);
}
if (results.length && !failed.length) console.log('  ALL-OK');
process.exit(firstFail);
