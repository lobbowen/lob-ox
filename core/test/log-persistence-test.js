#!/usr/bin/env node
'use strict';

// 日志与事件持久化行为（src/platform/service/log/{log,events}.js）：Logger 级别过滤 / 超限轮转保留一代 /
//   LineBuffer 跨 chunk 半行还原；Events 轮转备份 / seq 跨重启续号 / 轮转点即时持久化 / readSince 增量语义 / limit 钳制。

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-log-test-'));

let passed = 0;
let failed = 0;
function check(name, cond, extra = '') {
  if (cond) {
    passed++;
    console.log('  PASS ' + name);
  } else {
    failed++;
    console.log('  FAIL ' + name + (extra ? '  ← ' + extra : ''));
  }
}

// ---- Logger：级别过滤 + 轮转 + 行缓冲 ----
function testLogger() {
  const { createLogger, LineBuffer } = require(path.join(ROOT, 'src', 'platform', 'service', 'log', 'log'));
  const file = path.join(TMP, 'supervisor-test.log');
  const log = createLogger({ file, level: 'info', maxBytes: 400 });
  log.debug('不应出现');
  log.info('info-line');
  log.warn('warn-line');
  log.error('error-line');
  let lines = log.writer.tail(100);
  check('debug 被级别过滤；info/warn/error 均落盘且带级别标记',
    !lines.some((l) => l.includes('不应出现')) &&
    lines.some((l) => l.includes('[INFO] info-line')) &&
    lines.some((l) => l.includes('[WARN] warn-line')) &&
    lines.some((l) => l.includes('[ERROR] error-line')));
  for (let i = 0; i < 30; i++) log.writer.write('pad-line-' + i + ' '.repeat(20));
  // 轮转判定改用「首写 stat + 已写字节记账」，必须仍可封住体积（记账失控 = 日志无限增长）且保留一代。
  for (let i = 0; i < 200; i++) log.writer.write('x'.repeat(60));
  const logSize = fs.statSync(file).size;
  check('条1 记账不失控：连写 200 行后当前文件 < 2×maxBytes(400)，且保留一代非空备份',
    logSize < 800 && fs.existsSync(file + '.1') && fs.statSync(file + '.1').size > 0, 'size=' + logSize);
  // 行缓冲：半行 chunk 不落盘，拼接后完整
  let got = [];
  const lb = new LineBuffer((l) => got.push(l));
  lb.push('hel');
  lb.push('lo-world\nnext\n');
  lb.flush();
  check('LineBuffer 还原跨 chunk 半行', got.length === 2 && got[0] === 'hello-world' && got[1] === 'next', JSON.stringify(got));
}

// ---- Events 轮转 ----
function testEventsRotation() {
  const Events = require(path.join(ROOT, 'src', 'platform', 'service', 'log', 'events'));
  const file = path.join(TMP, 'events-rotation.log');
  // 阈值取 2048：40 条（约 90B/条，共约 3.6KB）恰好触发一次轮转；
  // keep-1 代策略下多次小阈值轮转会合法丢弃更早的代。
  const ev = new Events(file, 2048);
  for (let i = 0; i < 40; i++) ev.append('tick_event', { i });
  check('轮转后存在 .1 备份文件，且 seq 全局连续（40 条）、新实例续号不重置',
    fs.existsSync(file + '.1') && ev.seq === 40 && new Events(file, 600).seq === 40, String(ev.seq));
  const metaDoc = JSON.parse(fs.readFileSync(file + '.meta.json', 'utf8'));
  check('条1 轮转点即时持久化：meta.rotatedSeq == 内存水位（跨重启 .1 事件仍可见）',
    ev.rotatedSeq !== null && metaDoc.rotatedSeq === ev.rotatedSeq,
    'meta=' + JSON.stringify(metaDoc.rotatedSeq) + ' mem=' + JSON.stringify(ev.rotatedSeq));
  const all = ev.readSince(0, 500);
  check('readSince 跨轮转读全量', all.length === 40 && all[0].seq === 1 && all[39].seq === 40, String(all.length));
  const tail = ev.readSince(all[19].seq, 500);
  check('增量读取从 after+1 开始', tail.length === 20 && tail[0].seq === 21, JSON.stringify(tail.map((e) => e.seq)));
  check('limit 钳制：下限仍返回 ≥1 条、上限生效（5 条）',
    ev.readSince(0, -5).length >= 1 && ev.readSince(0, 5).length === 5);
}

testLogger();
testEventsRotation();

console.log('\n==============================');
console.log('结果: ' + passed + ' passed, ' + failed + ' failed');
// Windows libuv 兼容退出：process.exit() 在 handle 关闭竞态下触发 src\win\async.c:94
// 断言崩溃（exit 127）。Windows 改用 exitCode + 兜底定时器自然排空；其余平台保持原语义。
if (process.platform === 'win32') {
  process.exitCode = failed > 0 ? 1 : 0;
  setTimeout(() => { process.exit(process.exitCode); }, 200);
} else {
  process.exit(failed > 0 ? 1 : 0);
}
