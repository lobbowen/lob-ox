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
  const svcMod = require(path.join(ROOT, 'src', 'platform', 'os', 'service.js'));
  const v = svcMod.unitNameViolation;
  check('A4b 行为：合法名放行（裸名/.service/模板实例）',
    v('dsh-web@inst-1725-3') === null && v('dsh-no-such-unit-xyz.service') === null && v('main') === null, 'ok');
  check('A4b 行为：路径穿越/参数夹带/控制符/后缀伪装全部拒绝',
    v('../../evil') !== null && v('a --user stop b') !== null && v('x\n.service') !== null
      && v('foo.timer') !== null && v('foo.service\x00.txt') !== null && v('') !== null, 'ok');
  {
    const svc = svcMod.current();
    if (process.platform === 'linux' && svc.kind === 'systemd') {
      check('A4b 行为：非法名全链路拒（stopUnit=false / isUnitActive=false / transientUnitFile=null）',
        svc.stopUnit('../../evil') === false && svc.isUnitActive('../../evil') === false
        && svc.transientUnitFile('../x') === null, 'false');
      check('A4b 行为：非法名绝不进 systemctl argv（startTransient 抛 / cleanTransient={ok:false} / setLimits=false）',
        (() => { try { svc.startTransient({ unit: 'a b', cmd: ['node'] }); return false; } catch (e) { return /systemd-run 拒绝/.test(e.message); } })()
        && svc.cleanTransient('a/b').ok === false && svc.setLimits('../../evil', { memoryMax: '1G' }) === false,
        '已抛/ok:false');
    } else if (process.platform === 'linux' && svc.kind === 'portable') {
      check('A4b 行为：portable 档无锚 stopUnit 幂等 true（不误杀、不抛）；isUnitActive=null（删除保护不放行）',
        svc.stopUnit('../../evil', { port: 0, pidFile: null, anchors: [] }) === true
        && svc.isUnitActive('../../evil', {}) === null, 'true/null');
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

  // A6 原判据（"确实 active 的 systemd 单元 isUnitActive === true"）依赖 systemd 语义；
  //   服务管理器改为产品自身进程管理后该判据不再成立 ⇒ 换成 portable 下的等价性质：
  //   **给不存在的身份上下文时必须显式判 false，绝不因「查不到」而谎报活**。
  check('A6 反向：不存在的单元/无锚点上下文 isUnitActive === false（不谎报活）',
    svc.isUnitActive('dsh-no-such-unit-xyz.service') === false, 'false');
  check('A6b portable 档无身份锚点时不得冒充已知（unknown → null/false，非 true）',
    svc.isUnitActive('dsh-web@x', {}) !== true, 'no-ctx');
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
