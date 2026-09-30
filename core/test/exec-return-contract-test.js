#!/usr/bin/env node
'use strict';

// ---------------------------------------------------------------------------
// P0 回归：exec.run 的「成功/失败」判据必须与调用方语义一致
//
// 缺陷（一个根因，三处症状）：`execFileSync` 在 stdio **不捕获 stdout**（'ignore'）时
//   命令成功也返回 null，而 exec.run 契约是「失败/超时返回 null」-> 每个以 `!== null`
//   判成功的调用方都把成功读成失败：
//     · hasTool('node'/'systemctl'/'systemd-run') **恒 false** -> Linux 沙箱（多实例）全禁；
//     · hasIcacls 同形 -> Windows 敏感文件 icacls 收紧**静默失效**；
//     · service.js 的 run 包装无条件 stdio:'ignore' -> isUnitActive **恒 false** ->
//       升级误判「未启动」**误回滚**、删数据目录前的「仍活跃则不删」**永不生效**。
//
// 锁定不变量：A1 成功必返回非 null（即使 stdio 不捕获输出）· A2 失败仍 null ·
//   A3 hasTool(必然存在的 node) 为 true · A5 Linux sandboxLaunch 恒 true 且
//   sandboxEnforcement/provider 分派与 systemd-run 实际存在一致（不写死平台）·
//   A6 isUnitActive(确实 active 的单元) 为 true · A7 runAsync 绝不 reject。
// ---------------------------------------------------------------------------

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
//   旧形态的自证站（裸 execFileSync 在 stdio:ignore 下返回 null）已按减重裁定删除：
//   它判的是 Node 自身语义（本机环境事实），而 A1 主体断言的就是「同一调用经 exec.run 后非 null」。
{
  const r = ex.run('node', ['--version'], { stdio: 'ignore', timeoutMs: 5000 });
  check('A1 exec.run 成功且 stdio:ignore 时仍返回非 null（旧实现返回 null）',
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
  // 非零退出码也必须是 null（失败）
  const r3 = ex.run('node', ['-e', 'process.exit(3)'], { timeoutMs: 5000 });
  check('A2 非零退出码视为失败（null）', r3 === null, JSON.stringify(r3));
}

// -- A3：hasTool 对必然存在的命令为 true --
{
  // node 必然存在（我们正跑在 node 上）。旧实现此处恒 false。
  // 反向：不存在的命令必须 false（不能为了修 A3 变成恒 true）——同一判据的正反两面合成一条。
  check('A3 hasTool(node) === true（旧实现恒 false → 沙箱功能全禁）；不存在的命令 === false',
    osIdx.hasTool('node') === true && osIdx.hasTool('dsh-no-such-tool-xyz') === false,
    String(osIdx.hasTool('node')));
}

// -- A4b：B12 单元名白名单--
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
    // W3 后 linux 无 systemd-run 时 current() 落 portable——单元名动词在那侧不适用，按档位分支。
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
      // 非法名无从进任何 argv 或路径；无锚时 stopUnit 幂等 true 且绝不触碰进程。
      check('A4b 行为：portable 档无锚 stopUnit 幂等 true（不误杀、不抛）；isUnitActive=null（删除保护不放行）',
        svc.stopUnit('../../evil', { port: 0, pidFile: null, anchors: [] }) === true
        && svc.isUnitActive('../../evil', {}) === null, 'true/null');
    }
  }
  // A4b 的 `UNIT_NAME_RE.test('dsh-web@inst-1757-842')` 正则自证站已删：判据对象是内联字面量，
  //   且该单元名形态段与 service 域测试（X-3d）跨域重复。
}

// -- A5/A6：Linux 行为（systemd 真实存在时）--
if (process.platform === 'linux') {
  const svc = require(path.join(ROOT, 'src', 'platform', 'os', 'service.js')).current();
  // systemd-run 是否存在（用**可靠的** runOut 探测，而非本测试要验证的 hasTool）
  const hasRun = ex.runOut('systemd-run', ['--version'], { timeoutMs: 3000 }) !== null;
  const caps = osIdx.capabilities();
  // A5 原先三站（sandboxLaunch / sandboxEnforcement / provider kind）是同一「与 systemd-run 实测一致」判据的三次采样，合成一条。
  check('A5 Linux：sandboxLaunch 恒 true，且 sandboxEnforcement / provider 分派与 systemd-run 实际存在一致（不写死平台）',
    caps.sandboxLaunch === true
    && caps.sandboxEnforcement === (hasRun ? 'cgroup' : 'supervise')
    && svc.kind === (hasRun ? 'systemd' : 'portable'),
    JSON.stringify({ sandboxLaunch: caps.sandboxLaunch, sandboxEnforcement: caps.sandboxEnforcement, kind: svc.kind, hasRun: hasRun }));

  // 找一个确实 active 的 --user 单元，isUnitActive 必须为 true
  //  B12 后单元名只接受 *.service / 裸名——枚举必须限定 --type=service，
  //   否则宿主上恰好 active 的 .device/.mount 单元会被正确拒判为 false，误报本用例失败。
  let activeUnit = null;
  try {
    const out = ex.runOut('systemctl', ['--user', 'list-units', '--state=active', '--type=service', '--no-legend', '--plain'], { timeoutMs: 5000 });
    if (out) activeUnit = ((out.trim().split('\n')[0] || '').trim().split(/\s+/)[0]) || null;
    if (activeUnit && !/\.service$/.test(activeUnit)) activeUnit = null; // 与 A4b 白名单同判据，防非 service 混入
  } catch { /* 无 user session */ }
  if (activeUnit) {
    check('A6 isUnitActive(确实 active 的单元) === true（旧实现恒 false）',
      svc.isUnitActive(activeUnit) === true, activeUnit.slice(0, 50));
  } else {
    console.log('SKIP A6 本机无 active 的 --user service 单元（非 Linux user session）—— 非通过，仅跳过');
  }
  check('A6 反向：不存在的单元 isUnitActive === false',
    svc.isUnitActive('dsh-no-such-unit-xyz.service') === false, 'false');
}

// -- A7：runAsync/runOutAsync 的「绝不 reject」契约必须覆盖 execFile 的**同步抛**--
//   （Windows 上 npm.cmd 触发 Node EINVAL 缓解时 execFile 同步抛出；旧实现从 Promise
//    执行器逃逸成 rejection，_recordManifest 异步化后第一次踩中——U2/U3 win-x64 红。）
(async () => {
  const r = await ex.runAsync(null, ['--version'], { timeoutMs: 2000 }).then((x) => x, (e) => ({ rejected: e.message }));
  check('A7 runAsync 对 execFile 同步抛仍 resolve 失败结果（绝不 reject）',
    r && r.rejected === undefined && r.ok === false, JSON.stringify(r && r.error));
  const out = await ex.runOutAsync(null, ['--version'], { timeoutMs: 2000 }).then((x) => x, () => 'REJECTED');
  check('A7 runOutAsync 同步抛口径 = resolve(null)', out === null, JSON.stringify(out));
  // A7 原先的「裸 execFile 无兜底即 reject」自证站已按减重裁定删除：它判的是本机 Node 自身语义
  //   （与 A1 已删的前提自证站同类），不是产品行为。

  const failed = results.filter((x) => !x);
  console.log(String.fromCharCode(10) + '结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
  process.exit(failed.length ? 1 : 0);
})();
