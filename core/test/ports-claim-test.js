#!/usr/bin/env node
'use strict';


const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { safePort } = require(path.join(__dirname, '_ports'));
const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ports-claim-'));
const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined ? '  ← ' + x : '')); };
const RANGE = { base: 28130, count: 50 };

(async () => {
  const { PortRegistry } = require(path.join(ROOT, 'src', 'platform', 'service', 'ports'));
  const ports = new PortRegistry({ file: path.join(TMP, 'ports.json') });
  const claim = (owner, pref, extra) => ports.claimSlot('relay', owner, Object.assign({ range: RANGE }, pref ? { preferred: pref } : {}, extra || {}));

  console.log('== 确定性分配（preferred + 顺序补位）==');
  const m = await claim('relay:main', RANGE.base);
  check('main → base（preferred）', m && m.port === RANGE.base && !m.conflict, JSON.stringify(m));
  const a = await claim('relay:instA');
  const b = await claim('relay:instB');
  check('instA → base+1、instB → base+2（顺序补位）',
    a && a.port === RANGE.base + 1 && b && b.port === RANGE.base + 2, JSON.stringify([a, b]));

  console.log('== byOwner 复用（绑定持久，重启不漂移）==');
  const m2 = await claim('relay:main', RANGE.base);
  const b2 = await claim('relay:instB');
  check('main/instB 再 claim → 复用各自绑定（binding=true、不漂移）',
    m2 && m2.port === RANGE.base && m2.binding === true && !m2.bindingLost && b2 && b2.port === RANGE.base + 2,
    JSON.stringify([m2, b2]));

  console.log('== 删除后补位 + 单 owner 单端口 ==');
  ports.unregister('relay:instA');
  const c1 = await claim('relay:instC');
  check('A 释放后 instC → 补 base+1', c1 && c1.port === RANGE.base + 1, JSON.stringify(c1));
  const recs = ports.list().map((r) => r.port + ':' + r.owner);
  check('无重复端口、每 owner 一条', recs.length === new Set(recs.map((s) => s.split(':')[0])).size && recs.length === new Set(recs).size, JSON.stringify(recs));

  {
    const reg = new PortRegistry({ file: path.join(TMP, 'ports-release.json') });
    const P = 19001; // 两个动态池之外（managed 20000-23999 / providerApi 24000-25999）
    reg.registerUser(P, 'owner-A');

    let threw = null, ret;
    try { ret = reg.release(65500, 'owner-X'); } catch (e) { threw = e; }
    check('R-a release(未登记端口, ownerId) 不抛且返回 false（no-op）',
      threw === null && ret === false, threw ? threw.constructor.name + ': ' + threw.message : 'no-throw ret=' + ret);

    let threw2 = null, ret2;
    try { ret2 = reg.release(65501); } catch (e) { threw2 = e; }
    check('R-a release(未登记端口, 无 ownerId) 也不抛且返回 false',
      threw2 === null && ret2 === false, JSON.stringify({ threw2: !!threw2, ret2 }));

    check('R-b 错 owner → no-op 返回 false 且**不删**记录',
      reg.release(P, 'owner-B') === false && reg.isRegistered(P) === true, 'ok');
    check('R-b 对 owner → 释放返回 true',
      reg.release(P, 'owner-A') === true && reg.isRegistered(P) === false, 'ok');
  }

  console.log('== inst.wanPort 持久绑定优先 ==');
  const d = await claim('relay:instD', RANGE.base + 7);
  const d2 = await claim('relay:instD');
  check('instD 按 preferred 绑定 base+7，再 claim 复用同一绑定（绑定持久）',
    d && d.port === RANGE.base + 7 && d2 && d2.port === RANGE.base + 7 && d2.binding === true, JSON.stringify([d, d2]));

  console.log('== preferred advisory：被其它 owner 占 → 回退最小空闲，不中断 ==');
  ports._records.set(RANGE.base + 20, { port: RANGE.base + 20, role: 'relay', owner: 'relay:OTHER', createdAt: Date.now() });
  const fallback = await claim('relay:instE', RANGE.base + 20);
  const recE = ports.list().find((r) => r.owner === 'relay:instE');
  check('preferred 被异 owner 占 → 回退最小空闲且已登记（服务不中断）',
    fallback && !fallback.conflict && fallback.port !== RANGE.base + 20 && fallback.port >= RANGE.base && !!recE && recE.port === fallback.port, JSON.stringify(fallback));

  console.log('== binding 被盗（持久绑定记忆被异 owner 抢注）→ 迁移 + bindingLost 显式 ==');
  ports._records.set(RANGE.base, { port: RANGE.base, role: 'relay', owner: 'relay:THIEF', createdAt: Date.now() });
  let lost = null;
  const mig = await ports.claimSlot('relay', 'relay:main', {
    range: RANGE, preferred: RANGE.base, bindingPreferred: true,
    onBindingLost: (x) => { lost = x; },
  });
  const recMain = ports.list().find((r) => r.owner === 'relay:main');
  check('绑定被盗 → 迁移 + bindingLost 事件，且 main 已登记新端口（不静默）',
    mig && !mig.conflict && mig.bindingLost === true && mig.from === RANGE.base && !!lost && lost.to === mig.port && !!recMain && recMain.port === mig.port && recMain.port !== RANGE.base,
    JSON.stringify(mig) + ' lost=' + JSON.stringify(lost));

  // 注册表是多进程共享事实源：写口/冲突判读口进入前按指纹（mtime+size）自动对时；「以文件为 truth、未落盘内存记录丢弃」保留。
  {
    const p2 = new PortRegistry({ file: path.join(TMP, 'ports-resync.json') });
    await p2.claimSlot('relay', 'owner-A', { range: RANGE });
    const pA = p2.byOwner('owner-A');
    const pOther = new PortRegistry({ file: path.join(TMP, 'ports-resync.json') });
    const slotB = await pOther.claimSlot('relay', 'owner-B', { range: RANGE });
    check('RS-auto-1 外部进程新增记录无需手动 reload 即可见，且对时后既有绑定不丢（自动对时）',
      !!slotB && p2.byOwner('owner-B') === slotB.port && p2.byOwner('owner-A') === pA, String(p2.byOwner('owner-B')));
    p2._records.set(RANGE.base + 45, { port: RANGE.base + 45, role: 'relay', owner: 'owner-ghost', createdAt: Date.now() });
    await pOther.claimSlot('relay', 'owner-C', { range: RANGE }); // 外部再写一版文件
    check('RS-auto-3 反向：未落盘的内存注入对时后丢弃（以文件为准）',
      p2.byOwner('owner-ghost') === null, String(p2.byOwner('owner-ghost')));
  }

  {
    const net = require('node:net');
    const probe = require(path.join(ROOT, 'src', 'platform', 'service', 'ports', 'probe'));
    const RANGE2 = { base: 28200, count: 20 };
    const p6 = new PortRegistry({ file: path.join(TMP, 'ports-v6.json') });

    const occ = net.createServer();
    const v6Ok = await new Promise((res) => {
      occ.once('error', () => res(false));
      occ.listen(RANGE2.base + 3, '::1', () => res(true));
    });
    if (v6Ok) {
      check('isTaken 识出 IPv6-only 监听者、bindable 拒绝该端口（不得只探 127.0.0.1）',
        (await p6.isTaken(RANGE2.base + 3)) === true && (await probe.bindable(RANGE2.base + 3)) === false, 'taken');
      const got = await p6.claimSlot('relay', 'relay:v6owner', { range: RANGE2 });
      check('claimSlot 绕开 IPv6-only 占用端口', !!got && got.port !== RANGE2.base + 3 && !got.conflict, JSON.stringify(got));
      occ.close();
    } else {
      console.log('SKIP IPv6 探针：本机 ::1 不可绑定（无 IPv6 栈）');
      try { occ.close(); } catch {}
    }
    const occ4 = net.createServer();
    await new Promise((res) => { occ4.once('error', res); occ4.listen(RANGE2.base + 9, '127.0.0.1', res); });
    check('bindable 拒绝 IPv4 已占端口', (await probe.bindable(RANGE2.base + 9)) === false, 'false');
    occ4.close();

    const lockF = path.join(TMP, 'ports-xlock.json') + '.alloc.lock';
    const px = new PortRegistry({ file: path.join(TMP, 'ports-xlock.json') });
    fs.writeFileSync(lockF, String(process.pid));
    const t0 = Date.now();
    const slot = await px.claimSlot('relay', 'relay:xlock', { range: RANGE2 });
    check('持锁者在场：claimSlot 超时后 fail-open 仍完成分配（不冻结）',
      !!slot && slot.port > 0 && Date.now() - t0 >= 1000, 'took ' + (Date.now() - t0) + 'ms slot=' + JSON.stringify(slot));
    fs.unlinkSync(lockF);
    fs.writeFileSync(lockF, '999999');
    fs.utimesSync(lockF, new Date(Date.now() - 60000), new Date(Date.now() - 60000));
    const slot2 = await px.claimSlot('relay', 'relay:xlock2', { range: RANGE2 });
    check('stale 锁被老化接管（持有者崩溃不死锁）', !!slot2 && slot2.port > 0 && slot2.port !== slot.port, JSON.stringify(slot2));
    const px2 = new PortRegistry({ file: path.join(TMP, 'ports-xlock3.json') });
    await px2.claimSlot('relay', 'relay:clean', { range: { base: 28230, count: 10 } });
    check('正常分配后不残留 .alloc.lock', !fs.existsSync(path.join(TMP, 'ports-xlock3.json') + '.alloc.lock'), 'clean');
  }

  {
    const SOLE = 'supervisor-api';
    const pA = safePort('ports-claim', 4);
    const pB = safePort('ports-claim', 5);
    const pOld = safePort('ports-claim', 6);
    const pNew = safePort('ports-claim', 7);
    const pMain = safePort('ports-claim', 8);
    const sp = new PortRegistry({ file: path.join(TMP, 'ports-sole.json') });
    sp.register(SOLE, pA);
    sp.registerSole(SOLE, pB);
    sp.reload(); // 落盘后重读：桌面壳读的是同一份文件，唯一性必须两边一致
    const after = sp.list().filter((r) => r.role === SOLE);
    check('KI1 registerSole 换端口后同 role 唯一（内存+落盘一致）且 get(role) 指向新端口',
      after.length === 1 && after[0].port === pB && sp.get(SOLE) === pB, JSON.stringify(after));
    sp.register('dsh-main', pMain);
    sp.registerSole(SOLE, pB);
    check('KI1 registerSole 只清同 role，不误删其它固定端口',
      sp.get('dsh-main') === pMain && sp.get(SOLE) === pB, JSON.stringify(sp.list()));

    const sz = new PortRegistry({ file: path.join(TMP, 'ports-zombie.json') });
    sz._records.set(pOld, { port: pOld, role: SOLE, owner: 'system:' + SOLE, createdAt: 1 });
    sz._records.set(pNew, { port: pNew, role: SOLE, owner: 'system:' + SOLE, createdAt: 2 });
    const zombieRead = sz.get(SOLE); // 老读法「首个命中即返回」会在这里取到 pOld
    sz.registerSole(SOLE, pNew);
    check('KI1 双记录残留：get(role) 取最新登记，registerSole 清掉僵尸记录（升级后自愈）',
      zombieRead === pNew && sz.list().filter((r) => r.role === SOLE).length === 1 && sz.get(SOLE) === pNew, String(zombieRead));
  }

  {
    const { spawn } = require('node:child_process');
    const XF = path.join(TMP, 'ports-xproc.json');
    const XB = 28310; // 避开 _ports.js 全部已登记段（28000+27*10-1=28269 以内）
    fs.rmSync(XF, { force: true });
    const CHILD = [
      'const { PortRegistry } = require(' + JSON.stringify(path.join(ROOT, 'src', 'platform', 'service', 'ports', 'index.js')) + ');',
      'const reg = new PortRegistry({ file: process.argv[1] });',
      'console.log("READY");',
      'process.stdin.once("data", async () => {',
      '  const r = await reg.claimSlot("relay", "relay:longlive", { range: { base: ' + XB + ', count: 5 } });',
      '  console.log("RESULT:" + JSON.stringify(r));',
      '  process.exit(0);',
      '});',
    ].join('\n');
    const child = spawn(process.execPath, ['-e', CHILD, XF], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (c) => { out += c; });
    const deadline = Date.now() + 15000;
    while (out.indexOf('READY') < 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    const regA = new PortRegistry({ file: XF });
    regA.registerUser(XB, 'inst:stopped');
    child.stdin.on('error', () => { /* 子进程已亡：由下面的有界 exit 断言如实报红 */ });
    child.stdin.write('GO\n');
    const exitCode = await new Promise((res) => {
      const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} res('timeout'); }, 20000);
      child.once('exit', (c) => { clearTimeout(t); res(c); });
    });
    const line = (out.split('RESULT:')[1] || '').split('\n')[0];
    let bRes = null;
    try { bRes = JSON.parse(line); } catch { /* 保留 null 让断言如实报红 */ }
    check('跨进程：B 侧 claim 绕开 A 侧已登记的静默端口 ' + XB + '（陈旧快照不得抢注）',
      exitCode === 0 && !!bRes && !bRes.conflict && bRes.port > 0 && bRes.port !== XB,
      'exit=' + exitCode + ' bRes=' + line);
    const fileRecs = JSON.parse(fs.readFileSync(XF, 'utf8')).records;
    check('跨进程：B 侧落盘不丢写——ports.json 仍含 A 侧 inst:stopped@' + XB + '（全量覆盖=丢更新）',
      fileRecs.some((r) => r.port === XB && r.owner === 'inst:stopped'), JSON.stringify(fileRecs));
    check('跨进程：B 侧自己的绑定也在册（对时是合并视野而非失忆）',
      fileRecs.some((r) => r.owner === 'relay:longlive'), JSON.stringify(fileRecs.map((r) => r.owner)));
  }


  const failed = results.filter((r) => !r);
  console.log('\n结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
