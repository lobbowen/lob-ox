'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const sandbox = require('../instance/sandbox.js');
// 沙箱 env 隔离的单一实现（11 变量）在 agent 域。此前这里只设 4 个，
// 漏掉 USERPROFILE/XDG_*/APPDATA/LOCALAPPDATA/npm_config_*/TMPDIR——
// plugin 经此启动沙箱 DSH 时「各自独立数据目录」在这些位置实际失效。
const { sandboxEnv } = require('../agent/runtime/sandbox-env.js');

function pathExtra() {
  return (process.env.PATH || '') + path.delimiter + path.join(os.homedir(), '.npm-global', 'bin');
}

function nativeTarget(ctx) {
  return {
    id: 'native',
    name: '原生实例',
    kind: 'native',
    bin: ctx.dshBin,
    runtime: /\.(js|cjs|mjs)$/i.test(ctx.dshBin) ? process.execPath : null,
    profileDir: ctx.profileDir,
    profileName: ctx.profileName,
    env: { HOME: os.homedir(), PATH: pathExtra() },
  };
}

function sandboxTarget(ctx, inst) {
  if (!inst || inst.kind !== 'sandbox') return null;
  const dataDir = ctx.instances && ctx.instances.sandboxDataDir ? ctx.instances.sandboxDataDir(inst) : null;
  const installDir = ctx.instances && ctx.instances.sandboxInstallDir ? ctx.instances.sandboxInstallDir(inst) : null;
  if (!dataDir || !installDir) return null;
  
  const sandboxRoot = (ctx.instances && ctx.instances.sandboxRoot) ? path.dirname(ctx.instances.sandboxRoot(inst)) : path.dirname(path.dirname(installDir));
  return {
    id: inst.id,
    name: inst.name || inst.id,
    kind: 'sandbox',
    bin: sandbox.dshEntry(sandboxRoot, inst),
    runtime: process.execPath,
    installDir,
    profileDir: path.join(dataDir, '.dsh', 'profiles', ctx.profileName),
    profileName: ctx.profileName,
    // env 全量重定向走 agent 域单一实现（HOME/USERPROFILE/XDG 四件套/APPDATA/
    // LOCALAPPDATA/PATH/NODE_PATH/npm_config 三件/TMPDIR，Windows 另加 TMP/TEMP）。
    // DSH_HOME 是 DSH 自己的数据目录约定，叠加在隔离 env 之上。
    env: Object.assign(sandboxEnv({
      data: dataDir,
      install: installDir,
      nodeModules: sandbox.nodeModulesDir(sandboxRoot, inst),
      tmp: path.join(sandboxRoot, inst.id, 'tmp'),
    }).env, {
      DSH_HOME: path.join(dataDir, '.dsh'),
      PATH: pathExtra(),
    }),
    storeDir: process.platform === 'win32'
      ? path.join(os.homedir(), 'AppData', 'Local', 'pnpm', 'store')
      : path.join(os.homedir(), '.local', 'share', 'pnpm', 'store'),
  };
}

function allSandboxTargets(ctx) {
  const insts = (ctx.instances ? ctx.instances.all() : []).filter((x) => x.kind === 'sandbox');
  const out = [];
  for (const inst of insts) { const t = sandboxTarget(ctx, inst); if (t && fs.existsSync(t.bin)) out.push(t); }
  return out;
}

function resolveTargets(ctx, targetStr) {
  let str = (targetStr === undefined || targetStr === null || targetStr === '') ? 'native' : String(targetStr);
  if (str.startsWith('id:')) str = str.slice(3);
  if (str === 'native') return { ok: true, targets: [nativeTarget(ctx)] };
  if (str === 'all') return { ok: true, targets: [nativeTarget(ctx), ...allSandboxTargets(ctx)] };
  const inst = ctx.instances ? ctx.instances.find(str) : null;
  if (!inst || inst.kind !== 'sandbox') return { ok: false, error: '指定实例不存在或非沙箱实例: ' + str };
  const t = sandboxTarget(ctx, inst);
  if (!t) return { ok: false, error: '实例「' + (inst.name || inst.id) + '」缺少沙箱目录' };
  if (!fs.existsSync(t.bin)) return { ok: false, error: '实例「' + (inst.name || inst.id) + '」未安装 DeepSeek Harness，请先在实例管理中安装' };
  return { ok: true, targets: [t] };
}

module.exports = { nativeTarget, sandboxTarget, allSandboxTargets, resolveTargets };
