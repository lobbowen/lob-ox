#!/usr/bin/env node
'use strict';

// migrateByOwnerPrefix 契约（迁移S2）：router 自治端口段（owner 前缀 proxy:/providerApi:）从共享
// oldFile 迁出到 newFile 并清旧段；幂等；目标合并去重；守卫段保留在旧文件。
// 判据落在真文件字节上：迁移条数 + 旧文件残留 + 坏输入不崩（旧实现裸抛 -> 崩启动路径）。

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ports-mig-'));
const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined ? '  ← ' + x : '')); };

(async () => {
  const { PortRegistry } = require(path.join(ROOT, 'src', 'platform', 'service', 'ports'));
  // DS-G4（反转法）：owner 前缀是**域知识**，platform 只做通用前缀迁移 -> 由本域申报。
  const { OWNER_PREFIXES } = require(path.join(ROOT, 'src', 'domains', 'router', 'port-segments'));
  const ports = new PortRegistry({ file: path.join(TMP, 'unused.json') });
  const oldF = path.join(TMP, 'mig-old.json');
  const newF = path.join(TMP, 'mig-new.json');
  const isRouterRec = (r) => String((r && r.owner) || '').startsWith('proxy:') || String((r && r.owner) || '').startsWith('providerApi:');

  // 首次迁移：2 条 router 段（proxy:/providerApi:）迁出到新文件，旧文件只留守卫段。
  fs.writeFileSync(oldF, JSON.stringify({ records: [{ port: 28140, role: 'proxyInstance', owner: 'proxy:k1' }, { port: 28142, role: 'providerApi', owner: 'providerApi:p1' }, { port: 3080, role: 'dsh-main', owner: 'system:dsh-main' }, { port: 3081, role: 'user', owner: 'inst:main' }] }, null, 2));
  const moved = ports.migrateByOwnerPrefix(oldF, newF, OWNER_PREFIXES);
  const oldDoc = JSON.parse(fs.readFileSync(oldF, 'utf8'));
  const newDoc = JSON.parse(fs.readFileSync(newF, 'utf8'));
  check('MIG-1 迁出 2 条 router 段：新文件全为 router 段，旧文件保留守卫段且 router 段已清',
    moved === 2 && newDoc.records.length === 2 && newDoc.records.every(isRouterRec) && oldDoc.records.length === 2 && !oldDoc.records.some(isRouterRec),
    'moved=' + moved + ' old=' + JSON.stringify(oldDoc.records.map((r) => r.owner)));

  // 幂等（旧文件已无 router 段 -> 0 条）+ 目标已有记录时合并去重（不重复搬同一条）。
  const moved2 = ports.migrateByOwnerPrefix(oldF, newF, OWNER_PREFIXES);
  fs.writeFileSync(oldF, JSON.stringify({ records: [{ port: 28141, role: 'proxyInstance', owner: 'proxy:k2' }, { port: 3080, role: 'dsh-main', owner: 'system:dsh-main' }] }, null, 2));
  fs.writeFileSync(newF, JSON.stringify({ records: [{ port: 28140, role: 'proxyInstance', owner: 'proxy:k1' }] }, null, 2));
  const moved3 = ports.migrateByOwnerPrefix(oldF, newF, OWNER_PREFIXES);
  const newDoc3 = JSON.parse(fs.readFileSync(newF, 'utf8'));
  check('MIG-2 幂等（无 router 段时 0 条）且目标合并去重（新增 1 条、保留既有 1 条）',
    moved2 === 0 && moved3 === 1 && newDoc3.records.length === 2, 'idem=' + moved2 + ' moved=' + moved3 + ' recs=' + newDoc3.records.length);

  // -- MIG-3+：坏输入一律安全 no-op（旧实现或裸抛、或吞异常后照常清源 -> 两头无存） --
  {
    const cOld = path.join(TMP, 'mig-corrupt-old.json');
    const cNew = path.join(TMP, 'mig-corrupt-new.json');
    const junk = '{ records: [ 这不是JSON';
    const aOld = path.join(TMP, 'mig-array-doc.json');
    fs.writeFileSync(cOld, junk);
    fs.writeFileSync(aOld, JSON.stringify([1, 2, 3]));
    const out = [cOld, aOld].map((src) => { try { return { threw: null, r: ports.migrateByOwnerPrefix(src, cNew, OWNER_PREFIXES) }; } catch (e) { return { threw: e, r: null }; } });
    // 目标损坏：不得被覆盖，且绝不顺手清空源（否则源已清、目标没写 = 两头无存）。
    const tOld = path.join(TMP, 'mig-tbad-old.json');
    const tNew = path.join(TMP, 'mig-tbad-new.json');
    fs.writeFileSync(tOld, JSON.stringify({ records: [{ port: 28143, role: 'proxyInstance', owner: 'proxy:k9' }] }));
    fs.writeFileSync(tNew, 'corrupt{{{');
    let r2 = null, threw2 = null;
    try { r2 = ports.migrateByOwnerPrefix(tOld, tNew, OWNER_PREFIXES); } catch (e) { threw2 = e; }
    const tOldAfter = JSON.parse(fs.readFileSync(tOld, 'utf8'));
    check('MIG-3 源损坏/records 非数组/目标损坏：一律不抛、返回 0、源原样保留、坏目标未被清写',
      out.every((o) => o.threw === null && o.r === 0) && fs.readFileSync(cOld, 'utf8') === junk && !fs.existsSync(cNew)
      && threw2 === null && r2 === 0 && tOldAfter.records.length === 1 && fs.readFileSync(tNew, 'utf8') === 'corrupt{{{',
      out.map((o) => (o.threw ? o.threw.message : 'r=' + o.r)).join(' | ') + ' r2=' + r2);

    // 半途失败：目标存在（targetExisted 分支）且父目录只读 -> writeAtomic 第一步 EACCES，
    // 与「清源后写目标失败」同构：源已清 -> 必须回写源 + 上抛。
    const hOld = path.join(TMP, 'mig-halffail-old.json');
    const hDir = path.join(TMP, 'mig-halffail-ro.dir');
    const hNewFile = path.join(hDir, 'target.json');
    fs.mkdirSync(hDir);
    fs.writeFileSync(hNewFile, JSON.stringify({ records: [] })); // 合法空目标 -> targetExisted=true
    fs.writeFileSync(hOld, JSON.stringify({ records: [{ port: 28144, role: 'proxyInstance', owner: 'proxy:hf' }, { port: 3090, role: 'dsh-main', owner: 'system:dsh-main' }] }));
    let threw3 = 'skipped(win32: chmod 非强制)';
    if (process.platform !== 'win32') {
      fs.chmodSync(hDir, 0o500);
      try { ports.migrateByOwnerPrefix(hOld, hNewFile, OWNER_PREFIXES); threw3 = null; } catch (e) { threw3 = e; }
      fs.chmodSync(hDir, 0o755);
    }
    const hDoc = JSON.parse(fs.readFileSync(hOld, 'utf8'));
    check('MIG-4 半途失败：抛错上抛（旧实现清源失败静默）且源记录经回写保持完整（0 丢失 / 0 双登记）',
      (threw3 === 'skipped(win32: chmod 非强制)' || (!!threw3 && threw3.code === 'EACCES')) && hDoc.records.length === 2 && hDoc.records.some((x) => x.owner === 'proxy:hf'),
      (threw3 === null ? '未抛' : (threw3.code || threw3.message)) + ' recs=' + JSON.stringify(hDoc.records.map((x) => x.port)));
    try { fs.rmSync(hDir, { recursive: true, force: true }); } catch { /* 清理尽力 */ }
  }

  const failed = results.filter((r) => !r);
  console.log('\n结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
