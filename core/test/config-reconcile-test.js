#!/usr/bin/env node
'use strict';

// 配置调和测试：在线更新只换二进制、状态根不动 ⇒ 已落盘的“弃用值”必须由默认值覆盖。
// 实证故障：config.json 的 apiPort=36360 跨三个版本从未更新（老产品守卫常驻该端口
// ⇒ 新产品守卫永远命中「在服役·跳过启动」）。故 normalize 必须主动覆盖弃用值。

const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const results = [];
const check = (n, c, x) => { results.push(!!c); console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined ? '  ← ' + x : '')); };

(async () => {
  const cfg = require(path.join(ROOT, 'src', 'platform', 'service', 'config'));

  // 构造一份"完整且合法"的落盘配置：以默认值为基底，再覆盖要测的键。
  const raw = JSON.parse(JSON.stringify(cfg.DEFAULTS));
  raw.healthUrl = 'http://127.0.0.1:37360/healthz';
  raw.command = [process.execPath, 'x.js'];

  const mk = (o) => cfg.normalize(Object.assign({}, raw, o));

  // C-1：弃用端口必须被默认值覆盖（根治，而非读取时兜底）
  const dep = cfg.DEPRECATED_API_PORTS[0];
  const a = mk({ apiPort: dep });
  check(
    "C-1 落盘的弃用端口被默认值覆盖",
    a.apiPort !== dep && a.apiPort === cfg.BASE_DEFAULTS.apiPort,
    `落盘=${dep} → 实际=${a.apiPort}（默认=${cfg.BASE_DEFAULTS.apiPort}）`
  );

  // C-2：覆盖必须留痕（供上层写回与排障）
  check("C-2 覆盖行为留痕", Array.isArray(a.__deprecatedOverridden) && a.__deprecatedOverridden.includes("apiPort"),
    JSON.stringify(a.__deprecatedOverridden));

  // C-3：正常端口不得被改（不得误伤用户显式配置）
  const b = mk({ apiPort: 37360 });
  check("C-3 正常端口原样保留", b.apiPort === 37360, `实际=${b.apiPort}`);
  check("C-3b 正常端口不留覆盖痕", b.__deprecatedOverridden === undefined);

  // C-4：未落盘该键时取默认值
  const c = mk({});
  check("C-4 缺键取默认值", c.apiPort === cfg.BASE_DEFAULTS.apiPort, `实际=${c.apiPort}`);

  // C-5：默认值自身不得落在弃用名单（否则每次启动都会被迁走）
  check(
    "C-5 默认端口不在弃用名单内",
    !cfg.isDeprecatedApiPort(cfg.BASE_DEFAULTS.apiPort),
    `默认=${cfg.BASE_DEFAULTS.apiPort} 弃用名单=${JSON.stringify(cfg.DEPRECATED_API_PORTS)}`
  );

  // C-6：判定函数边界（非数字不误判）
  check("C-6 非数字不判弃用", !cfg.isDeprecatedApiPort("36360") === false || !cfg.isDeprecatedApiPort(undefined));

  const failed = results.filter((r) => !r).length;
  console.log(`\n结果: ${results.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();