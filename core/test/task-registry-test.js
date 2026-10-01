'use strict';


const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { TaskRegistry } = require(path.join(__dirname, '..', 'src', 'platform', 'service', 'tasks'));

let failures = 0;
function check(name, ok, extra) {
  if (ok) console.log('  PASS ' + name);
  else { failures++; console.log('  FAIL ' + name + (extra ? ' :: ' + extra : '')); }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'task-reg-test-'));

async function main() {
  const reg = new TaskRegistry({ stateDir: TMP });
  const t = reg.begin('native', 'upgrade', { id: 'main', name: '原生 DSH' }, { from: '0.1.1', to: '0.1.2' });
  check('创建任务为 pending，isBusy 与 current 同步可见', t.state === 'pending' && reg.isBusy('native', 'main') === true && reg.current('native', 'main').id === t.id);
  reg.start(t.id);
  check('start → running', reg.get(t.id).state === 'running');
  const s1 = reg.step(t.id, '停止 DSH');
  reg.stepState(t.id, reg.get(t.id).steps.indexOf(s1), 'running');
  reg.stepState(t.id, reg.get(t.id).steps.indexOf(s1), 'done');
  reg.log(t.id, '安装中…');
  reg.log(t.id, '安装完成');
  reg.succeed(t.id);
  check('succeed → succeeded', reg.get(t.id).state === 'succeeded');
  check('完成后 isBusy 释放、current 返回 null', reg.isBusy('native', 'main') === false && reg.current('native', 'main') === null);
  check('步骤推进与日志留痕（同一任务的两面簿记）',
    reg.get(t.id).steps[0].state === 'done' && reg.get(t.id).log.length === 2 && reg.get(t.id).log[0].includes('安装中'));

  const t2 = reg.begin('plugin', 'install', { id: 'native', name: '原生' }, { to: 'x' });
  reg.start(t2.id);
  reg.fail(t2.id, 'npm 退出码 1');
  check('fail → failed + error', reg.get(t2.id).state === 'failed' && reg.get(t2.id).error === 'npm 退出码 1');
  const t3 = reg.begin('native', 'upgrade', { id: 'main', name: '原生 DSH' }, {});
  reg.start(t3.id);
  reg.skip(t3.id, '已是最新');
  check('skip → skipped', reg.get(t3.id).state === 'skipped');

  const t4 = reg.begin('instance', 'upgrade', { id: 'inst-1', name: '实例1' }, {});
  reg.start(t4.id);
  reg.step(t4.id, '安装');
  const reg2 = new TaskRegistry({ stateDir: TMP }); // 重新加载（等价守卫重启）
  const recovered = reg2.get(t4.id);
  check('重启后任务历史保留', recovered !== null);
  check('运行中任务重启后标记 failed', recovered && recovered.state === 'failed' && recovered.error.includes('守卫重启'));
  const t1 = reg2.get(t.id);
  check('已完成任务状态保留 succeeded', t1 && t1.state === 'succeeded');
  check('重启后 isBusy 释放', reg2.isBusy('instance', 'inst-1') === false);

  // 守卫与 router-daemon 各持一个 TaskRegistry 写同一个 tasks.json，而 _save 整份覆盖 ⇒ 落盘前必须重读磁盘按 id 合并（本方优先）。
  {
    const TMP2 = fs.mkdtempSync(path.join(os.tmpdir(), 'task-xproc-'));
    const guard = new TaskRegistry({ stateDir: TMP2 });   // 模拟守卫进程
    const daemon = new TaskRegistry({ stateDir: TMP2 });  // 模拟 router-daemon 进程
    const g1 = guard.begin('native', 'install', { id: 'main', name: '原生 DSH' }, {});
    guard.start(g1.id);
    const d1 = daemon.begin('proxy-app', 'update', { id: 'app1', name: 'Proxy' }, {});
    daemon.start(d1.id);
    const disk = JSON.parse(fs.readFileSync(path.join(TMP2, 'tasks.json'), 'utf8'));
    const kinds = disk.tasks.map((x) => x.kind + '/' + x.action);
    check('跨进程：守卫与 daemon 的任务都留在磁盘（不得只留一侧）',
      kinds.indexOf('native/install') >= 0 && kinds.indexOf('proxy-app/update') >= 0, kinds.join(','));
    const g2 = guard.begin('native', 'upgrade', { id: 'main', name: '原生 DSH' }, {});
    guard.start(g2.id);
    const disk2 = JSON.parse(fs.readFileSync(path.join(TMP2, 'tasks.json'), 'utf8'));
    const ids = disk2.tasks.map((x) => x.id);
    check('跨进程：任务 id 无重复', new Set(ids).size === ids.length, String(ids.length));
    check('跨进程：daemon 的条目在守卫后续写入后仍在',
      disk2.tasks.some((x) => x.kind === 'proxy-app'), 'ok');
    check('跨进程：守卫自己看到 2 条', guard.list().length === 2, String(guard.list().length));
    fs.rmSync(TMP2, { recursive: true, force: true });
  }

  console.log(failures === 0 ? '\ntask-registry: ALL PASS' : '\ntask-registry: ' + failures + ' FAILED');
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
