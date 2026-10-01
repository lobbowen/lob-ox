#!/usr/bin/env node
'use strict';

// 受管 daemon 路径回归：直接调用**真实的原型方法**（不重新实现路径逻辑），
//   K1-a/b router 与 lan 生命周期可构造 · K1-c script 指向真实存在的文件 ·
//   K1-d 无 configPath 时仍返回 null（测试/非守卫实例不越权管理）。

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  ← ' + x : '')); };

// 取真实 mixin 的 `_daemonLifecycle` 描述符。
//  步骤7：_daemonLifecycle 已从 control-view.js 拆到 app/daemons/runtime.js；
//   导出形态从属性描述符改为 { methods }。
const mod = require(path.join(ROOT, 'src', 'app', 'daemons', 'runtime.js'));
const { installCollaborators } = require(path.join(ROOT, 'src', 'app', 'assembly', 'collaborators'));
const fn = mod.methods._daemonLifecycle;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'k1daemon-'));
const cfgPath = path.join(tmp, 'config.json');
fs.writeFileSync(cfgPath, JSON.stringify({ stateFile: path.join(tmp, 'state.json') }));

/** 最小上下文：只提供 `_daemonLifecycle` 真正读取的字段。 */
function ctx(configPath) {
  return installCollaborators({
    configPath,
    config: { stateFile: path.join(tmp, 'state.json') },
    logger: { warn() {}, info() {}, error() {} },
    _routerCtlPort: () => 43107,
    _lanCtlPort: () => 43108,
    _lc: null,
  });
}

for (const kind of ['router', 'lan']) {
  let inst = null;
  let err = null;
  try { inst = fn.call(ctx(cfgPath), kind); } catch (e) { err = e; }
  check('K1-a ' + kind + ' daemon 生命周期可构造（非 null）', !err && !!inst,
    err ? ('抛错: ' + err.message) : (inst ? 'ok' : 'null（路径解析失败 → 该 daemon 永不启动）'));
  if (inst) {
    // 字段名取自 DaemonLifecycle 的公开字段 `script`（src/app/daemons/process.js:22）——猜错会让断言在产品无恙时假红。
    const script = inst.script;
    check('K1-c ' + kind + ' script 指向真实文件', !!script && fs.existsSync(script), String(script));
  }
}

// 无 configPath -> 必须返回 null（不越权管理独立 daemon）
{
  let r = null;
  let e2 = null;
  try { r = fn.call(ctx(null), 'router'); } catch (e) { e2 = e; }
  check('K1-d 无 configPath 时返回 null（测试实例不越权）', !e2 && r === null,
    e2 ? ('抛错: ' + e2.message) : String(r));
}

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}

const failed = results.filter((r) => !r);
console.log(String.fromCharCode(10) + '结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
process.exit(failed.length ? 1 : 0);