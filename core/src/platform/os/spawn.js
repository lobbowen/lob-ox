'use strict';

// 异步子进程统一封装（NO-CONSOLE-WINDOW-STANDARD，契约冻结）：src 内的异步 spawn 只走本文件。
// windowsHide:true 在三个入口写死、调用方不可覆盖：Windows 上 detached:true 会给子进程新建控制台
// 窗口，能隐藏它的只有 windowsHide。逐处补字段正是漏隐藏的成因，故不开放覆盖。
// 窗口可见性与生命周期正交：detached/stdio 语义由各入口自身定义，不随隐藏策略变化（分工见各函数）。

const { spawn } = require('node:child_process');

/** 独立进程组（后台常驻：主 DSH / daemon / 反代）。
 *  固定 detached:true（进程组语义不得因隐藏窗口而丢失，kill(-pid) 依赖它）与 windowsHide:true。
 *  stdio 默认 ignore，允许经 opts.stdio 覆盖；覆盖只动 stdio，不放开 detached/windowsHide。 */
function detached(cmd, args, opts) {
  const o = opts || {};
  return spawn(cmd, args, Object.assign({}, o, {
    detached: true,
    windowsHide: true,
    // 默认 ignore；显式 undefined 也回落 ignore，避免 stdio:undefined 的歧义。
    stdio: o.stdio === undefined ? 'ignore' : o.stdio,
  }));
}

/** 管道模式（需要读输出：npm install / 插件 CLI / frpc）。
 *  固定 stdio ['ignore','pipe','pipe'] 与 windowsHide:true；opts.detached 可显式覆盖（默认 false），
 *  因为是否自成进程组是调用方的生命周期决策，与窗口隐藏无关。 */
function piped(cmd, args, opts) {
  const o = opts || {};
  return spawn(cmd, args, Object.assign({}, o, {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    detached: o.detached === true,
  }));
}

/** 浏览器 / OS 打开等「完全脱离本进程且不读输出」的场景：等价于 detached + stdio ignore。 */
function detachedIgnored(cmd, args, opts) {
  const o = opts || {};
  return spawn(cmd, args, Object.assign({}, o, {
    detached: true,
    windowsHide: true,
    stdio: 'ignore',
  }));
}

module.exports = { detached, piped, detachedIgnored };
