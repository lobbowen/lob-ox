#!/usr/bin/env node
'use strict';


const path = require('node:path');
const ROOT = path.join(__dirname, '..');

const results = [];
const check = (n, c, x) => {
  results.push(!!c);
  console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined ? '  <- ' + x : ''));
};

const EXECH = path.join(ROOT, 'src', 'platform', 'util', 'exec.js');
const WIN32 = path.join(ROOT, 'src', 'platform', 'os', 'autostart', 'win32.js');
const BRAND = require(path.join(ROOT, 'src', 'shared', 'brand.js'));

const calls = [];
let detailOk = true;
let detailErr = null;
let queryOut = '';
require.cache[EXECH] = {
  id: EXECH, filename: EXECH, loaded: true,
  exports: {
    run: () => ({ ok: true }),
    runOut: (bin, args) => { calls.push({ fn: 'runOut', bin, args }); return queryOut; },
    runDetail: (bin, args) => { calls.push({ fn: 'runDetail', bin, args }); return detailOk ? { ok: true } : { ok: false, error: detailErr }; },
  },
};
delete require.cache[WIN32];
const win32 = require(WIN32);

calls.length = 0; detailOk = true;
let r = win32.setGuiAutostart(true, { guiCommand: () => 'C:\\Program Files\\lobox\\lobox-shell.exe' });
const create = calls.find((c) => c.fn === 'runDetail' && c.args.includes('/Create'));
check('W-a1 on=true 必须真调 schtasks /Create（旧版不执行却谎报 ok:true，闭包零测试命中）',
  !!create && create.args.includes('/TN') && create.args.includes(BRAND.WINDOWS_GUI_TASK)
  && create.args.some((a) => String(a).includes('lobox-shell.exe')), JSON.stringify(calls));
check('W-a2 create 成功 → ok:true 且 task 名如实回显',
  r.ok === true && r.task === BRAND.WINDOWS_GUI_TASK, JSON.stringify(r));

calls.length = 0;
r = win32.setGuiAutostart(true);
check('W-a3 缺 deps → ok:false 且零执行（没有 guiCommand 就不可能知道注册哪个 exe，禁止静默成功）',
  r.ok === false && calls.length === 0, JSON.stringify(r));

calls.length = 0; detailOk = false; detailErr = '拒绝访问。';
r = win32.setGuiAutostart(true, { guiCommand: () => 'C:\\x\\lobox-shell.exe' });
check('W-a4 schtasks 失败 → ok:false + error 原样透传（不得假成功）',
  r.ok === false && String(r.error || '').includes('拒绝访问'), JSON.stringify(r));

calls.length = 0; detailOk = true; detailErr = null; queryOut = BRAND.WINDOWS_GUI_TASK;
r = win32.setGuiAutostart(false, { guiCommand: () => 'C:\\x\\lobox-shell.exe' });
const del = calls.find((c) => c.fn === 'runDetail' && c.args.includes('/Delete'));
check('W-a5 on=false 且任务在册 → /Delete 真执行且 ok:true',
  !!del && r.ok === true, JSON.stringify(calls));

calls.length = 0; queryOut = '';
r = win32.setGuiAutostart(false, { guiCommand: () => 'C:\\x\\lobox-shell.exe' });
check('W-a6 on=false 且任务不在册 → 幂等：不发删除、ok:true',
  r.ok === true && !calls.some((c) => c.fn === 'runDetail'), JSON.stringify(calls));

process.exit(results.every(Boolean) ? 0 : 1);
