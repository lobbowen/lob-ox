'use strict';

// 插件域 CLI 执行（无状态函数）：以目标描述的 env/runtime 起 dsh plugin 子进程，整树超时终止，逐行回吐日志；registryOrigin/logger 显式入参。
// 注意：test/round8-fixes-test.js J-i/J-g 按域聚合断言本文件的 spawn/detached、杀树单源（procOS.killTree）与
//   registry 注入形态；改这些形态要同步改判据。

// 统一 spawn 封装（NO-CONSOLE-WINDOW-STANDARD W1）：Windows 上 detached 会新建控制台窗口，
// 故经 spawn.piped({detached:true})，它固定 windowsHide:true。
const spawn = require('../../platform/os/spawn');
// 整树终止走平台层单源（platform/os/process.killTree）：Windows 无进程组语义，域内自写组信号只杀得到
// .cmd 那层壳，pnpm 孙进程照旧成孤儿。
const procOS = require('../../platform/os/process');
// 镜像基址的形态与注入形态只有一个口（platform/distribution/registry-ref），域内不再各写一遍 env 键。
const registryRef = require('../../platform/distribution/registry-ref');
const { assertSafeCliArgs, cliArgv } = require('./policies');

const CLI_TIMEOUT_MS = 180000;
const DEFAULT_REGISTRY = 'https://registry.npmjs.org';

/** 经 dist 统一镜像源选择 registry 基址（不可达降级官方源）。 */
async function registryOrigin(dist) {
  if (dist) { try { return await dist.registryOrigin(false); } catch {} }
  return DEFAULT_REGISTRY;
}

/** 执行 dsh plugin CLI（整树终止 + 超时）。 */
function runCli({ target, args, opts, registryOrigin, logger }) {
  const guardErr = assertSafeCliArgs(args);
  const o = opts || {};
  const timeoutMs = o.timeoutMs || CLI_TIMEOUT_MS;
  return new Promise((resolve) => {
    if (guardErr) return resolve({ ok: false, error: guardErr });
    let settled = false;
    let timer = null; // 置于 executor 顶层：settle 闭包必须能访问（放 .then 内会引用越界、resolve 不执行）
    const settle = (v) => { if (!settled) { settled = true; if (timer) clearTimeout(timer); resolve(v); } };
    Promise.resolve().then(() => registryOrigin()).then((regRaw) => {
      // registry 注入只有 registry-ref 一个口：非法基址与 null/空一样「完全不注入该键」，
      // 因为 Node spawn 会把值强转成字符串，pnpm 收到 npm_config_registry='null' 或畸形地址时
      // 报的错与真实原因（全镜像不可达 / 基址非法）无关，诊断会被带偏。
      const rp = registryRef.registryEnvPair(regRaw);
      const envBase = Object.assign({}, process.env, target.env);
      if (rp.ok) Object.assign(envBase, rp.env);
      else if (logger && logger.warn) logger.warn('plugin CLI: 无可用的 registry 镜像（' + rp.violation + '），回退 pnpm 默认（npmjs.org）');
      const env = envBase;
      let child;
      try {
        // 沙箱 target 固定 pnpm store（--store-dir 传给 dsh plugin），
        // 防 HOME 变化（沙箱隔离）导致 ERR_PNPM_UNEXPECTED_STORE。
        const cliArgs = cliArgv(target);
        // detached:true 让子进程自成进程组，超时才能整树终止；否则只杀得到直接子进程，
        // dsh plugin -> pnpm 的孙进程（真正在安装的那个）会成孤儿，继续占 profile 目录与 pnpm store 锁。
        // 入口可能是包内 JS（原生绑定后/沙箱）-> 用 node <js> plugin ...；纯垫片直接执行。
        const argv0 = target.runtime || target.bin;
        const argvPrefix = target.runtime ? [target.bin] : [];
        child = spawn.piped(argv0, [...argvPrefix, ...cliArgs, ...args], { env, detached: true });
      } catch (e) { return settle({ ok: false, error: e.message }); }
      // 整树终止（POSIX 进程组；Windows 经 taskkill /T /F，两平台语义等价）
      const killTree = (sig) => {
        if (!child || !child.pid) return;
        // ownGroup：detached 子进程必为本组组长，故组信号安全（判据见 platform/os/process）。
        try { procOS.killTree(child.pid, sig, () => {}, { ownGroup: true }); } catch { /* 尽力而为 */ }
      };
      timer = setTimeout(() => {
        killTree('SIGTERM');
        // 兜底：SIGTERM 后 3s 未退则 SIGKILL，防不响应挂死
        setTimeout(() => killTree('SIGKILL'), 3000).unref();
        settle({ ok: false, error: '执行超时（' + Math.round(timeoutMs / 1000) + 's）' });
      }, timeoutMs);
      const push = (buf) => {
        if (typeof o.onLine !== 'function') return;
        for (const l of String(buf).split(/\r?\n/)) { const t = l.trim(); if (t) { try { o.onLine(t); } catch {} } }
      };
      child.stdout.on('data', push);
      child.stderr.on('data', push);
      child.on('error', (e) => settle({ ok: false, error: e.message }));
      // 用 exit 而非 close：CLI 完成后的后台子进程会继承 stdout pipe，
      // 导致 close 永不触发（job 永远 running）。exit 不依赖 stdio 关闭。
      child.on('exit', (code) => settle({ ok: code === 0, error: code === 0 ? null : '退出码 ' + code }));
    }).catch((e) => settle({ ok: false, error: e.message }));
  });
}

module.exports = { registryOrigin, runCli };
