'use strict';

// 插件域目标解析（只读 fs）：把前端 target 串（native / all / id:<实例> / 实例 id）解析成可执行
// 目标描述。全部显式传 ctx（配置 + instances 句柄），不读 this；仅 fs.existsSync 只读探测。

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

/** PATH 追加 ~/.npm-global/bin（npm 全局安装的可执行目录）。 */
function pathExtra() {
  return (process.env.PATH || '') + path.delimiter + path.join(os.homedir(), '.npm-global', 'bin');
}

/** 原生 DSH 目标。 */
function nativeTarget(ctx) {
  return {
    id: 'native',
    name: '原生实例',
    kind: 'native',
    bin: ctx.dshBin,
    // 绑定后的原生入口可能是包内 JS（.../lib/bin.js），必须用 node 承载（Windows 上 .js 不可直接执行）。
    runtime: /\.(js|cjs|mjs)$/i.test(ctx.dshBin) ? process.execPath : null,
    profileDir: ctx.profileDir,
    profileName: ctx.profileName,
    env: { HOME: os.homedir(), PATH: pathExtra() },
  };
}

/** 沙箱实例目标（无目录信息则 null）。 */
function sandboxTarget(ctx, inst) {
  if (!inst || inst.domain !== 'sandbox') return null;
  const dataDir = ctx.instances && ctx.instances.sandboxDataDir ? ctx.instances.sandboxDataDir(inst) : null;
  const installDir = ctx.instances && ctx.instances.sandboxInstallDir ? ctx.instances.sandboxInstallDir(inst) : null;
  if (!dataDir || !installDir) return null;
  return {
    id: inst.id,
    name: inst.name || inst.id,
    kind: 'sandbox',
    bin: path.join(installDir, 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    runtime: process.execPath, // 包内 JS 入口：显式 node 承载（跨平台一致）
    installDir,
    profileDir: path.join(dataDir, '.dsh', 'profiles', ctx.profileName),
    profileName: ctx.profileName,
    env: {
      HOME: dataDir,
      DSH_HOME: path.join(dataDir, '.dsh'), // 关键：dsh plugin CLI 用 DSH_HOME 解析 profile 目录（优先级高于 ~/.dsh）
      NODE_PATH: path.join(installDir, 'lib', 'node_modules'),
      PATH: pathExtra(),
    },
    storeDir: path.join(os.homedir(), '.local', 'share', 'pnpm', 'store'), // 固定真实 pnpm store（防 HOME 变化导致 ERR_PNPM_UNEXPECTED_STORE）
  };
}

/** 所有已安装 DSH 的沙箱目标（bin 存在才算）。 */
function allSandboxTargets(ctx) {
  const insts = (ctx.instances ? ctx.instances.all() : []).filter((x) => x.domain === 'sandbox');
  const out = [];
  for (const inst of insts) { const t = sandboxTarget(ctx, inst); if (t && fs.existsSync(t.bin)) out.push(t); }
  return out;
}

/** target 串 -> 目标列表。 */
function resolveTargets(ctx, targetStr) {
  let str = (targetStr === undefined || targetStr === null || targetStr === '') ? 'native' : String(targetStr);
  if (str.startsWith('id:')) str = str.slice(3); // 前端目标前缀（id:<实例id>）
  if (str === 'native') return { ok: true, targets: [nativeTarget(ctx)] };
  if (str === 'all') return { ok: true, targets: [nativeTarget(ctx), ...allSandboxTargets(ctx)] };
  const inst = ctx.instances ? ctx.instances.find(str) : null;
  if (!inst || inst.domain !== 'sandbox') return { ok: false, error: '指定实例不存在或非沙箱实例: ' + str };
  const t = sandboxTarget(ctx, inst);
  if (!t) return { ok: false, error: '实例「' + (inst.name || inst.id) + '」缺少沙箱目录' };
  if (!fs.existsSync(t.bin)) return { ok: false, error: '实例「' + (inst.name || inst.id) + '」未安装 DeepSeek Harness，请先在实例管理中安装' };
  return { ok: true, targets: [t] };
}

module.exports = { nativeTarget, sandboxTarget, allSandboxTargets, resolveTargets };
