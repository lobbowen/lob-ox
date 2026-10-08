#!/usr/bin/env node
'use strict';

// execFileSync 在 stdio 不捕获 stdout（'ignore'）时命令成功也返回 null，而契约是「失败/超时返回 null」⇒ 以 !== null 判成功的调用方全部读反。

const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const ex = require(path.join(ROOT, 'src', 'platform', 'util', 'exec.js'));
const osIdx = require(path.join(ROOT, 'src', 'platform', 'os', 'index.js'));

const results = [];
const check = (n, c, x) => {
  results.push(!!c);
  console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  <- ' + x : ''));
};

{
  const r = ex.run('node', ['--version'], { stdio: 'ignore', timeoutMs: 5000 });
  check('A1 exec.run 成功且 stdio:ignore 时仍返回非 null',
    r !== null && r !== undefined, JSON.stringify(r));
  const r2 = ex.runOut('node', ['--version'], { timeoutMs: 5000 });
  check('A1 exec.runOut 成功返回版本串', typeof r2 === 'string' && /^v\d+/.test(r2.trim()), JSON.stringify(r2));
}

{
  const r = ex.run('dsh-no-such-binary-xyz', [], { timeoutMs: 3000 });
  const r2 = ex.runOut('dsh-no-such-binary-xyz', [], { timeoutMs: 3000 });
  check('A2 不存在的可执行文件仍返回 null（run 与 runOut 失败语义未被破坏）',
    r === null && r2 === null, JSON.stringify(r));
  const r3 = ex.run('node', ['-e', 'process.exit(3)'], { timeoutMs: 5000 });
  check('A2 非零退出码视为失败（null）', r3 === null, JSON.stringify(r3));
}

{
  check('A3 hasTool(node) === true（判定错则沙箱功能全禁）；不存在的命令 === false',
    osIdx.hasTool('node') === true && osIdx.hasTool('dsh-no-such-tool-xyz') === false,
    String(osIdx.hasTool('node')));
}

{
  // 单元名白名单的**归属**是 util/input.js（service.js 只是转发过一层）。
  //   服务管理器去系统化后该转发已删（只服务 systemd 档）⇒ 直接从源头取，避免测试依赖已删转发。
  const v = require(path.join(ROOT, 'src', 'platform', 'util', 'input.js')).unitNameViolation;
  check('A4b 行为：合法名放行（裸名/.service/模板实例）',
    v('dsh-web@inst-1725-3') === null && v('dsh-no-such-unit-xyz.service') === null && v('main') === null, 'ok');
  check('A4b 行为：路径穿越/参数夹带/控制符/后缀伪装全部拒绝',
    v('../../evil') !== null && v('a --user stop b') !== null && v('x\n.service') !== null
      && v('foo.timer') !== null && v('foo.service\x00.txt') !== null && v('') !== null, 'ok');
  {
    // `svcMod` 在此重新取（上面第 41 行起不再 require 整个模块）；
    //   服务管理器恒为 portable（不借 OS 通道）⇒ systemd 分支永不生效，只断言 portable 语义。
    const svc = require(path.join(ROOT, 'src', 'platform', 'os', 'service.js')).current();
    // isUnitActive 现返回 Outcome 三态（根因 A 修法）：未知 = {kind:'unknown'}，不再是 null。
    // 被测性质不变：**查无实据不得放行**（不得是 ok）。
    const K = (x) => String((x && x.kind) || x);
    // 审计 P0-I5：stopUnit 已为 async（不再用 Atomics.wait 冻结事件循环）；此处用 .then 落地断言，
    // 不引入顶层 await（CJS 顶层的 await 非法）。断言在本拍后续同步检查之后微任务内完成，与尾部异步 IIFE 的退出顺序一致。
    if (svc.kind === 'portable') {
      Promise.resolve(svc.stopUnit('../../evil', { port: 0, pidFile: null, anchors: [] })).then((stopped) => {
        check('A4b 行为：portable 档无锚 stopUnit 幂等 true（不误杀、不抛）；isUnitActive=unknown（删除保护不放行）',
          stopped === true && K(svc.isUnitActive('../../evil', {})) === 'unknown',
          'true/' + K(svc.isUnitActive('../../evil', {})));
      }).catch(() => {});
    }
  }
}

if (process.platform === 'linux') {
  const svc = require(path.join(ROOT, 'src', 'platform', 'os', 'service.js')).current();
  const hasRun = ex.runOut('systemd-run', ['--version'], { timeoutMs: 3000 }) !== null;
  const caps = osIdx.capabilities();
  // ★ 服务管理器不借 OS 通道（唯一权威：STANDARDS.md）：即使本机有 systemd-run，
  //   服务控制器也必须走产品自身的进程管理（portable），限额档位如实为 supervise（不再 cgroup）。
  check('A5 Linux：sandboxLaunch 恒 true；provider 恒 portable、限额恒 supervise（不随 systemd-run 存在而分叉）',
    caps.sandboxLaunch === true
    && caps.sandboxEnforcement === 'supervise'
    && svc.kind === 'portable',
    JSON.stringify({ sandboxLaunch: caps.sandboxLaunch, sandboxEnforcement: caps.sandboxEnforcement, kind: svc.kind, hasRun: hasRun }));

  // ★ portable 档（产品自身进程管理）下：`isUnitActive` 返回 Outcome 三态：
  //   ok（在跑）/ fail（确定不在跑）/ unknown（判不出）。旧契约的 null 已由 unknown 取代。
  //   被测性质不变：**绝不谎报活**（任何"查无实据"的形态都不得是 ok）。
  const K2 = (x) => String((x && x.kind) || x);
  check('A6 未知形态不谎报活：无身份上下文 isUnitActive !== ok（unknown/fail 皆可）',
    K2(svc.isUnitActive('dsh-no-such-unit-xyz.service')) !== 'ok', K2(svc.isUnitActive('dsh-no-such-unit-xyz.service')));
  // 给了 pidFile（不存在）⇒ 进程槽位为空 ⇒ 确定不在跑（fail）
  const deadCtx = { port: 1, pidFile: path.join(__dirname, 'no-such-run.pid'), anchors: ['nope-anchor'] };
  check('A6b 有身份上下文但 pid 文件不存在 ⇒ isUnitActive = fail（可判定就判定）',
    K2(svc.isUnitActive('dsh-web@x', deadCtx)) === 'fail', K2(svc.isUnitActive('dsh-web@x', deadCtx)));
  check('A6c portable 档无锚点时不得冒充已知（unknown，非 ok）',
    K2(svc.isUnitActive('dsh-web@x', {})) !== 'ok', K2(svc.isUnitActive('dsh-web@x', {})));
}

// runAsync/runOutAsync 的「绝不 reject」必须覆盖 execFile 的同步抛（Windows 上 npm.cmd 触发 Node EINVAL）。
(async () => {
  const r = await ex.runAsync(null, ['--version'], { timeoutMs: 2000 }).then((x) => x, (e) => ({ rejected: e.message }));
  check('A7 runAsync 对 execFile 同步抛仍 resolve 失败结果（绝不 reject）',
    r && r.rejected === undefined && r.ok === false, JSON.stringify(r && r.error));
  const out = await ex.runOutAsync(null, ['--version'], { timeoutMs: 2000 }).then((x) => x, () => 'REJECTED');
  check('A7 runOutAsync 同步抛口径 = resolve(null)', out === null, JSON.stringify(out));

  const failed = results.filter((x) => !x);
  console.log(String.fromCharCode(10) + '结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
  process.exit(failed.length ? 1 : 0);
})();
