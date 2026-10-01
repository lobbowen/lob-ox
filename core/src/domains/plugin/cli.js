'use strict';

const spawn = require('../../platform/os/spawn');
const procOS = require('../../platform/os/process');
const registryRef = require('../../platform/distribution/registry-ref');
const { assertSafeCliArgs, cliArgv } = require('./policies');

const CLI_TIMEOUT_MS = 180000;
const DEFAULT_REGISTRY = 'https://registry.npmjs.org';

async function registryOrigin(dist) {
  if (dist) { try { return await dist.registryOrigin(false); } catch {} }
  return DEFAULT_REGISTRY;
}

function runCli({ target, args, opts, registryOrigin, logger }) {
  const guardErr = assertSafeCliArgs(args);
  const o = opts || {};
  const timeoutMs = o.timeoutMs || CLI_TIMEOUT_MS;
  return new Promise((resolve) => {
    if (guardErr) return resolve({ ok: false, error: guardErr });
    let settled = false;
    let timer = null;
    const settle = (v) => { if (!settled) { settled = true; if (timer) clearTimeout(timer); resolve(v); } };
    Promise.resolve().then(() => registryOrigin()).then((regRaw) => {
      const rp = registryRef.registryEnvPair(regRaw);
      const envBase = Object.assign({}, process.env, target.env);
      if (rp.ok) Object.assign(envBase, rp.env);
      else if (logger && logger.warn) logger.warn('plugin CLI: 无可用的 registry 镜像（' + rp.violation + '），回退 pnpm 默认（npmjs.org）');
      const env = envBase;
      let child;
      try {
        // 沙箱 target 固定 pnpm store（--store-dir），防 HOME 变化导致 ERR_PNPM_UNEXPECTED_STORE。
        const cliArgs = cliArgv(target);
        // detached:true 让子进程自成进程组，超时才能整树终止（否则 pnpm 孙进程成孤儿仍占 profile 与 store 锁）。
        const argv0 = target.runtime || target.bin;
        const argvPrefix = target.runtime ? [target.bin] : [];
        child = spawn.piped(argv0, [...argvPrefix, ...cliArgs, ...args], { env, detached: true });
      } catch (e) { return settle({ ok: false, error: e.message }); }
      const killTree = (sig) => {
        if (!child || !child.pid) return;
        try { procOS.killTree(child.pid, sig, () => {}, { ownGroup: true }); } catch {  }
      };
      timer = setTimeout(() => {
        killTree('SIGTERM');
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
      child.on('exit', (code) => settle({ ok: code === 0, error: code === 0 ? null : '退出码 ' + code }));
    }).catch((e) => settle({ ok: false, error: e.message }));
  });
}

module.exports = { registryOrigin, runCli };
