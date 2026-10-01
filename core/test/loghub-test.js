#!/usr/bin/env node
'use strict';

// 系统日志框架回归：装配键契约（supervisor 用短键 ctlPorts/daemonLogs {router,lan}，EventHub 内部长键
//   which('router-daemon')）· daemon 事件经 ctl eventsTail 增量入聚合（首拉建基线不回溯）· internal 标 · LogCore 单例语义。

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const http = require('node:http');
const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'loghub-test-'));
const { EventHub, isInternalEvent } = require(path.join(ROOT, 'src', 'platform', 'service', 'log', 'hub'));
// 反转法：源名/内部簿记类型由 app/assembly/log-sources.js 声明注入（不在 platform 硬编码）。
// 平台门面（logcore）负责在装配落地前完成注入：凡经 logcore 装配的路径（含本测试）行为不变；
// 生产路径另由 compose.js 在 LogCore.init 前无条件 require 同一模块。
require(path.join(ROOT, 'src', 'app', 'assembly', 'log-sources'));
const LogCore = require(path.join(ROOT, 'src', 'platform', 'service', 'log', 'logcore'));
const Events = require(path.join(ROOT, 'src', 'platform', 'service', 'log', 'events'));
// 步骤4：通用 dispatcher 上移 L0。白名单必填（fail-closed）——此处只测内置 eventsTail。
const { createCtlServer } = require(path.join(ROOT, 'src', 'platform', 'ctl', 'server'));

let passed = 0;
let failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log('  PASS ' + name); }
  else { failed++; console.log('  FAIL ' + name + (extra !== undefined ? '  ← ' + JSON.stringify(extra) : '')); }
}
const freePort = () => new Promise((res) => { const s = http.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });

(async () => {
  // 1) 装配键契约 + daemon ctl 增量入聚合（模拟 supervisor 短键装配）
  {
    const de = new Events(path.join(TMP, 'router.events.log'), 1 << 20, { process: 'router-daemon' });
    de.append('router_old', {}); // 存量（首拉不回溯）
    const ctlPort = await freePort();
    const ctl = createCtlServer({ target: null, allowMethods: ['eventsTail'], events: de, logger: null });
    await new Promise((r) => ctl.listen(ctlPort, '127.0.0.1', r));
    const ge = new Events(path.join(TMP, 'guard.events.log'), 1 << 20, { process: 'guard' });
    const hub = new EventHub({ stateDir: path.join(TMP, 's1'), aggBase: 'state', guardEvents: ge, guardLogFile: '', dshLogFile: '', upgradeLogFile: '', daemonLogs: {}, ctlPorts: { router: ctlPort, lan: 0 }, eventsMaxBytes: 1 << 20, logger: { debug() {}, warn() {} } });
    ge.attachHub(hub);
    ge.append('spawned', { pid: 9 });
    for (let i = 0; i < 8; i++) await hub.sync(); // 首拉建基线（应不含 router_old）
    de.append('router_new', { k: 2 });
    for (let i = 0; i < 8; i++) await hub.sync();
    const all = hub.read(0, 50);
    const rEvs = all.filter((e) => e.source === 'router-daemon');
    check('短键装配: daemon 事件经 ctl 入聚合(不含存量)', rEvs.length === 1 && rEvs[0].type === 'router_new', all.map((e) => e.type + '@' + e.source));
    check('聚合行带 producer=router-daemon 与 internal 标', rEvs[0].producer && rEvs[0].producer.process === 'router-daemon' && rEvs[0].internal === false, rEvs[0]);
    ctl.close();
  }
  // 2) internal 判定/打标/默认过滤（时间线只显示业务事件）+ 历史行(internal 缺失)按类型兜底
  {
    const ge = new Events(path.join(TMP, 'guard2.events.log'), 1 << 20, { process: 'guard' });
    const hub = new EventHub({ stateDir: path.join(TMP, 's2'), aggBase: 'state', guardEvents: ge, guardLogFile: '', dshLogFile: '', upgradeLogFile: '', daemonLogs: {}, ctlPorts: {}, eventsMaxBytes: 1 << 20, logger: { debug() {} } });
    ge.attachHub(hub);
    ge.append('shadow_dsh_action', { diff: false });
    ge.append('managed_object_updated', { kind: 'dsh' });
    ge.append('router_daemon_supervised', { pid: 9 });
    ge.append('running', { pid: 1 });
    const all = hub.read(0, 20);
    check('内部簿记名单判定+打标+默认过滤后只剩业务事件',
      isInternalEvent('shadow_dsh_action') && isInternalEvent('managed_object_updated') && isInternalEvent('router_daemon_supervised')
      && !isInternalEvent('running')
      && all.find((e) => e.type === 'shadow_dsh_action').internal === true && all.find((e) => e.type === 'running').internal === false
      && all.filter((e) => !e.internal).map((e) => e.type).join(',') === 'running');
    // 直接经 writer 造"历史遗留行"（internal 字段缺失）-> readVisible 须按类型兜底过滤
    hub.writer.appendRaw({ ts: new Date().toISOString(), type: 'managed_object_updated', data: {}, source: 'guard', srcSeq: 1 });
    hub.writer.appendRaw({ ts: new Date().toISOString(), type: 'running', data: {}, source: 'guard', srcSeq: 2 });
    const vis = hub.readVisible(0, 20);
    check('readVisible 兜底: internal 缺失历史行被过滤', vis.every((e) => e.type !== 'managed_object_updated') && vis.some((e) => e.type === 'running'), vis.map((e) => e.type));
  }
  // 2b) 事件人性化：裸类型业务事件注入可读 message（不改源事件/源文件）
  {
    const ge = new Events(path.join(TMP, 'guard-hum.events.log'), 1 << 20, { process: 'guard' });
    const hub = new EventHub({ stateDir: path.join(TMP, 'shum'), aggBase: 'state', guardEvents: ge, guardLogFile: '', dshLogFile: '', upgradeLogFile: '', daemonLogs: {}, ctlPorts: {}, eventsMaxBytes: 1 << 20, logger: { debug() {} } });
    ge.attachHub(hub);
    ge.append('lan_cookie_exchanged', { id: 'main', via: 'refresh' });
    ge.append('spawned', { pid: 9 });
    const all = hub.read(0, 20);
    const cookie = all.find((e) => e.type === 'lan_cookie_exchanged');
    const spawned = all.find((e) => e.type === 'spawned');
    const src = JSON.parse(fs.readFileSync(path.join(TMP, 'guard-hum.events.log'), 'utf8').trim().split('\n')[0]);
    check('人性化: 有模板类型带可读 message、无模板类型不带，且源文件行不被污染',
      !!cookie && !!cookie.data && typeof cookie.data.message === 'string' && cookie.data.message.length > 0
      && !!spawned && !('message' in spawned.data) && !('message' in (src.data || {})));
  }
  // 3) LogCore 单例语义
  {
    LogCore._resetForTest();
    const c = LogCore.init({ process: 'guard' });
    check('init guard ok(events/logger) 且同 process 幂等', c.process === 'guard' && !!c.events && !!c.logger && c.hub === null
      && LogCore.init({ process: 'guard' }) === c);
    let threw = false;
    try { LogCore.init({ process: 'lan-daemon' }); } catch { threw = true; }
    check('异进程拒绝', threw);
    LogCore._resetForTest();
    const u = LogCore.get();
    check('未 init get 惰性默认不落盘', u.process === 'unknown' && !!u.logger && !!u.events);
    LogCore._resetForTest();
  }
  // 4) metrics / filter / export / tailLog 冒烟
  {
    const ge = new Events(path.join(TMP, 'guard3.events.log'), 1 << 20, { process: 'guard' });
    fs.writeFileSync(path.join(TMP, 'g.log'), 'a\nb\n');
    const hub = new EventHub({ stateDir: path.join(TMP, 's3'), aggBase: 'state', guardEvents: ge, guardLogFile: path.join(TMP, 'g.log'), dshLogFile: '', upgradeLogFile: '', daemonLogs: { router: path.join(TMP, 'r.log'), lan: path.join(TMP, 'l.log') }, ctlPorts: {}, eventsMaxBytes: 1 << 20, logger: { debug() {} } });
    ge.attachHub(hub);
    ge.append('spawned', { pid: 1 });
    ge.append('running', { pid: 1 });
    const m = hub.metrics();
    check('metrics 事件派生', m.events === 2 && m.bySource.guard === 2);
    check('readFiltered type=spawned', hub.readFiltered({ type: 'spawned' }, 0, 10).length === 1);
    check('exportLines JSONL', hub.exportLines(0, 10).length === 2);
    check('tailLog 有文件/无文件两分支（guard 取值 / router 不抛返回空）',
      hub.tailLog('guard', 1).join('') === 'b' && hub.tailLog('router', 1).length === 0); // lan daemonLogs 短键，文件不存在返回空不抛
  }
  // 5) EventReader 读适配器（空对象适配器：接口完备 + 与 EventHub 同源）。
  {
    const { EventReader } = require(path.join(ROOT, 'src', 'platform', 'service', 'log', 'hub'));
    const fakeEvents = { seq: 7, readAll: () => ([{ seq: 1, type: 'a' }, { seq: 2, type: 'shadow_beat' }]), readSince: (a, l) => [{ seq: 1, type: 'a' }] };
    const rd = new EventReader(fakeEvents);
    const ifaceOk = ['seq', 'read', 'readVisible', 'readFiltered', 'tailLog', 'exportLines', 'metrics', 'sync']
      .every((m) => (m === 'seq' ? typeof rd[m] !== 'undefined' : typeof rd[m] === 'function'));
    check('P4-C EventReader 实现完整读接口', ifaceOk, 'ok');
    check('P4-D EventReader.readVisible 过滤 internal 且同 EventHub 语义', rd.readVisible(0, 50).every((e) => e.type !== 'shadow_beat'), JSON.stringify(rd.readVisible(0, 50)));
    check('P4-E EventReader.seq 透传本地事件流', rd.seq === 7, 'seq=' + rd.seq);
  }
  console.log('\n结果: ' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
