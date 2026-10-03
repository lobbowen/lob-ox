#!/usr/bin/env node
'use strict';

// 一条一个进程：链中测试普遍以 process.exit() 收尾，in-process 串联会被首个退出码掐断。

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
// 必须相对：子进程 cmdline 会被被测层当归属锚点读回来，而绝对路径把检出目录名写进每条 cmdline，src/app/main/signals.js 的接管判据含「命令行出现过 dsh」子串匹配 ⇒ 测试进程被守卫 SIGTERM。
const PRELOAD = './test/_preload.js';

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
  // --only 是「CI 等价复现」入口（R2），但它此前**跳过 os 过滤** ⇒ 在本机能选中 CI 上根本不跑的
  // POSIX-only 测试（如 sigterm-desired-test.js）⇒ 红灯被误读成"代码坏了"，实为平台不适用（已实测）。
  // 正解：--only 也按宿主过滤，并显式告知被跳过者（不静默丢掉，避免"以为跑了其实没跑"）。
  if (ONLY.length) {
    const before = picked.length;
    picked = picked.filter((e) => MANIFEST.osSet(e).indexOf(process.platform) >= 0);
    if (picked.length !== before) {
      const skipped = ONLY.filter((o) => !picked.some((e) => norm(e.file) === norm(o)));
      console.error('::notice::--only 中 ' + skipped.length + ' 个条目在本宿主（' + process.platform + '）不适用，未执行: ' + skipped.join(', '));
    }
    if (!picked.length) {
      console.error('::error::--only 的所有条目在本宿主（' + process.platform + '）均不适用（见 manifest 的 os 过滤）⇒ 无从复现');
      process.exit(2);
    }
  }
}

const results = [];
let firstFail = 0;
for (const entry of picked) {
  const started = Date.now();
  const r = spawnSync(process.execPath, ['-r', PRELOAD, entry.file], {
    cwd: ROOT, stdio: 'inherit', windowsHide: true,
  });
  const code = r.status === null ? -1 : r.status;
  // status=null = 被子进程收到的信号打死；不记信号名，红点就退化成「它挂了」。
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
