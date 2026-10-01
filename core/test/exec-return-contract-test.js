#!/usr/bin/env node
'use strict';

// exec.run 的「成功/失败」判据必须与调用方语义一致：execFileSync 在 stdio 不捕获 stdout（'ignore'）时
//   命令成功也返回 null，而契约是「失败/超时返回 null」⇒ 以 `!== null` 判成功的调用方全部读反
//   （hasTool / isUnitActive 恒 false ⇒ Linux 沙箱全禁、升级误判未启动而误回滚）。A1 成功必非 null · A2 失败仍 null · A3/A4b/A5/A6/A7。

const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const ex = require(path.join(ROOT, 'src', 'platform', 'util', 'exec.js'));
const osIdx = require(path.join(ROOT, 'src', 'platform', 'os', 'index.js'));

const results = [];
const check = (n, c, x) => {
  results.push(!!c);
  console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  <- ' + x : ''));
};

// -- A1：成功必非 null（核心）--
{
  const r = ex.run('node', ['--version'], { stdio: 'ignore', timeoutMs: 5000 });
  check('A1 exec.run 成功且 stdio:ignore 时仍返回非 null',
    r !== null && r !== undefined, JSON.stringify(r));
  const r2 = ex.runOut('node', ['--version'], { timeoutMs: 5000 });
  check('A1 exec.runOut 成功返回版本串', typeof r2 === 'string' && /^v\d+/.test(r2.trim()), JSON.stringify(r2));
}

// -- A2：失败仍是 null --
{
  const r = ex.run('dsh-no-such-binary-xyz', [], { timeoutMs: 3000 });
  const r2 = ex.runOut('dsh-no-such-binary-xyz', [], { timeoutMs: 3000 });
  check('A2 不存在的可执行文件仍返回 null（run 与 runOut 失败语义未被破坏）',
    r === null && r2 === null, JSON.stringify(r));
  // 非零退出码也必须是 null（失败）。
  const r3 = ex.run('node', ['-e', 'process.exit(3)'], { timeoutMs: 5000 });
  check('A2 非零退出码视为失败（null）', r3 === null, JSON.stringify(r3));
}

// -- A3：hasTool 对必然存在的命令为 true --
{
  // node 必然存在（我们正跑在 node 上）；反向：不存在的命令必须 false（不能为修 A3 变成恒 true）。
  check('A3 hasTool(node) === true（判定错则沙箱功能全禁）；不存在的命令 === false',
    osIdx.hasTool('node') === true && osIdx.hasTool('dsh-no-such-tool-xyz') === false,
    String(osIdx.hasTool('node')));
}

// -- A4b：单元名白名单 --
{
  const svcMod = require(path.join(ROOT, 'src', 'platform', 'os', 'service.js'));
  const v = svcMod.unitNameViolation;
  check('A4b 行为：合法名放行（裸名/.service/模板实例）',
    v('dsh-web@inst-1725-3') === null && v('dsh-no-such-unit-xyz.service') === null && v('main') === null, 'ok');
  check('A4b 行为：路径穿越/参数夹带/控制符/后缀伪装全部拒绝',
    v('../../evil') !== null && v('a --user stop b') !== null && v('x\n.service') !== null
      && v('foo.timer') !== null && v('foo.service\x00.txt') !== null && v('') !== null, 'ok');
  {
    // Linux 行为闸：非法名不得触达 systemctl（stopUnit=false、startTransient 抛、文件路径=null）。
    // linux 无 systemd-run 时 current() 落 portable，单元名动词在那侧不适用，按档位分支。
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
      // portable 安全不变量（构造性）：动词不消费 unit 名、杀进程只认端口/cmdline 锚，
      //   非法名无从进任何 argv 或路径；无锚时 stopUnit 幂等 true 且绝不触碰进程。
      check('A4b 行为：portable 档无锚 stopUnit 幂等 true（不误杀、不抛）；isUnitActive=null（删除保护不放行）',
        svc.stopUnit('../../evil', { port: 0, pidFile: null, anchors: [] }) === true
        && svc.isUnitActive('../../evil', {}) === null, 'true/null');
    }
  }
}

// -- A5/A6：Linux 行为（systemd 真实存在时）--
if (process.platform === 'linux') {
  const svc = require(path.join(ROOT, 'src', 'platform', 'os', 'service.js')).current();
  // systemd-run 是否存在（用**可靠的** runOut 探测，而非本测试要验证的 hasTool）
  const hasRun = ex.runOut('systemd-run', ['--version'], { timeoutMs: 3000 }) !== null;
  const caps = osIdx.capabilities();
  check('A5 Linux：sandboxLaunch 恒 true，且 sandboxEnforcement / provider 分派与 systemd-run 实际存在一致（不写死平台）',
    caps.sandboxLaunch === true
    && caps.sandboxEnforcement === (hasRun ? 'cgroup' : 'supervise')
    && svc.kind === (hasRun ? 'systemd' : 'portable'),
    JSON.stringify({ sandboxLaunch: caps.sandboxLaunch, sandboxEnforcement: caps.sandboxEnforcement, kind: svc.kind, hasRun: hasRun }));

  // 找一个确实 active 的 --user 单元，isUnitActive 必须为 true；
  //   单元名只接受 *.service / 裸名 ⇒ 枚举必须限定 --type=service，否则 .device/.mount 会被判 false 而误报。
  let activeUnit = null;
  try {
    const out = ex.runOut('systemctl', ['--user', 'list-units', '--state=active', '--type=service', '--no-legend', '--plain'], { timeoutMs: 5000 });
    if (out) activeUnit = ((out.trim().split('\n')[0] || '').trim().split(/\s+/)[0]) || null;
    if (activeUnit && !/\.service$/.test(activeUnit)) activeUnit = null; // 与 A4b 白名单同判据，防非 service 混入
  } catch { /* 无 user session */ }
  if (activeUnit) {
    check('A6 isUnitActive(确实 active 的单元) === true',
      svc.isUnitActive(activeUnit) === true, activeUnit.slice(0, 50));
  } else {
    console.log('SKIP A6 本机无 active 的 --user service 单元（非 Linux user session）—— 非通过，仅跳过');
  }
  check('A6 反向：不存在的单元 isUnitActive === false',
    svc.isUnitActive('dsh-no-such-unit-xyz.service') === false, 'false');
}

// -- A7：runAsync/runOutAsync 的「绝不 reject」契约必须覆盖 execFile 的**同步抛** --
//   （Windows 上 npm.cmd 触发 Node EINVAL 缓解时 execFile 同步抛出，异常不得从 Promise 执行器逃逸成 rejection。）
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
