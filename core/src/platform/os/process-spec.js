'use strict';

/**
 * ProcessSpec —— 进程构造的唯一入口（根因 C2 的修法）。
 *
 * 背景（实证）：进程 argv 在本仓 5 处各自拼装，且安全不变量靠"每个调用方记得传"：
 *   * plugin/cli.js 的 npm 安装**不传 --ignore-scripts**，而 distribution/install.js:60,70 无条件 push
 *     ⇒ 插件包可通过 preinstall/postinstall 执行任意代码，且子进程继承父进程完整环境（含 NPM_TOKEN）
 *   * --port 的格式在 config.js / native/command.js / router providers / instance/sandbox 各写一遍
 *   * plugin overlay 是**事后 splice**（nativeCommand 里 fs.existsSync 判存再插 --patch）⇒ spawn 期 TOCTOU
 *
 * 修法：声明式 spec → 校验 → 生成 argv。**安全不变量内置于构造器**，
 * 任何经 ProcessSpec 的路径都不可能漏掉，不再依赖调用方记忆。
 *
 * 复用既有白名单：platform/util/input.js 的 PKG_NAME_RE / ARGV_UNSAFE_RE
 * （distribution/install.js:42 已在用，插件域此前是全仓唯一没接的）。
 */

const input = require('../util/input');

// 安全不变量：安装类操作一律禁用生命周期脚本。
// 与 distribution/install.js:18 的 IGNORE_SCRIPTS_FLAG 同一条不变量——此处内置，
// 使"新写一个安装路径"也不可能漏（此前正是漏在插件域）。
const IGNORE_SCRIPTS_FLAG = '--ignore-scripts';
const NO_IGNORE_SCRIPTS_FLAG = '--no-ignore-scripts';

// 允许透传给子进程的环境变量白名单（其余一律不透传）。
// 背景：此前 Object.assign({}, process.env, target.env) 把父进程完整环境交给 pnpm，
// 含 NPM_TOKEN / npm_config__auth / GITHUB_TOKEN 等 ⇒ 恶意包的生命周期脚本可直接读取。
const ENV_PASSTHROUGH = [
  'PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP',
  'SystemRoot', 'SystemDrive', 'COMSPEC', 'PATHEXT',
  'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'ProgramData', 'ProgramFiles',
  'LANG', 'LC_ALL', 'TZ',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy',
];

function defaultSpec() {
  return {
    runtime: null,      // 解释器（如 node）；为 null 表示 bin 可直接执行
    bin: null,          // 可执行文件或入口脚本
    subcommand: null,   // 子命令（如 'web' / 'plugin'）
    args: [],           // 用户参数
    port: null,         // --port 值（一等公民，不再各处拼装）
    patchFile: null,    // 插件 overlay（一等公民，不再事后 splice）
    storeDir: null,     // pnpm --store-dir
    install: false,     // 是否安装类操作（决定是否注入安全标志）
    extraFlags: [],     // 其他固定标志
  };
}

/** 校验：拒绝含不安全字符或路径遍历形态的参数 */
function validate(spec) {
  const errs = [];
  const check = (v, what) => {
    if (v === null || v === undefined) return;
    const s = String(v);
    if (input.ARGV_UNSAFE_RE.test(s)) errs.push(what + ' 含 argv 禁用字符: ' + s.slice(0, 40));
    if (s.indexOf('..') >= 0) errs.push(what + ' 含路径遍历形态: ' + s.slice(0, 40));
  };
  check(spec.bin, 'bin');
  check(spec.runtime, 'runtime');
  check(spec.subcommand, 'subcommand');
  check(spec.patchFile, 'patchFile');
  check(spec.storeDir, 'storeDir');
  for (const a of spec.args || []) check(a, 'arg');
  if (spec.port !== null && spec.port !== undefined) {
    const p = Number(spec.port);
    if (!Number.isInteger(p) || p <= 0 || p > 65535) errs.push('非法端口: ' + spec.port);
  }
  return errs;
}

/**
 * 生成 argv。
 * 顺序：runtime → bin → subcommand → 固定标志（--store-dir/--port/--patch） → 用户参数 → 安全标志
 *
 * ⚠️ port 的语义是"覆盖"而非"追加"：若用户参数里已含 --port / -p / --port=，
 * 先剔除它们再统一注入 spec.port（否则 argv 出现两个 --port，下游取哪个都是未定义行为）。
 * 这与 nativeCommand 旧逻辑（扫到 --port 即替换）保持等价。
 */
function build(specIn) {
  const spec = Object.assign(defaultSpec(), specIn || {});
  const errs = validate(spec);
  if (errs.length) return { ok: false, error: errs.join('; '), argv: null };

  const out = [];
  if (spec.runtime) out.push(spec.runtime);
  if (spec.bin) out.push(spec.bin);
  if (spec.subcommand) out.push(spec.subcommand);

  for (const f of spec.extraFlags || []) out.push(f);
  if (spec.storeDir) out.push('--store-dir', String(spec.storeDir));

  // 剔除用户参数里既有的 port 形式，改由下面统一注入（覆盖语义）
  const args = [];
  const rawArgs = spec.args || [];
  for (let i = 0; i < rawArgs.length; i += 1) {
    const a = String(rawArgs[i]);
    if (a === '--port' || a === '-p') { i += 1; continue; }   // 跳过标记及其值
    if (/^--port=/.test(a)) continue;
    args.push(a);
  }

  if (spec.port !== null && spec.port !== undefined) out.push('--port', String(spec.port));
  if (spec.patchFile) out.push('--patch', String(spec.patchFile));
  for (const a of args) out.push(a);

  // 安全不变量：安装类操作补 --ignore-scripts；用户显式写了 --no-ignore-scripts 则尊重
  // （与 distribution/install.js:60 的既有约定保持一致）。
  const lowered = out.map((x) => String(x));
  if (spec.install && lowered.indexOf(IGNORE_SCRIPTS_FLAG) < 0 && lowered.indexOf(NO_IGNORE_SCRIPTS_FLAG) < 0) {
    out.push(IGNORE_SCRIPTS_FLAG);
  }
  return { ok: true, error: null, argv: out };
}

/**
 * 子进程环境：白名单透传 + target 覆盖 + registry 注入。
 * 不再整体继承 process.env（防凭据泄漏给生命周期脚本）。
 */
function childEnv(targetEnv, registryEnv) {
  const out = {};
  for (const k of ENV_PASSTHROUGH) {
    if (process.env[k] !== undefined) out[k] = process.env[k];
  }
  if (targetEnv) Object.assign(out, targetEnv);
  if (registryEnv) Object.assign(out, registryEnv);
  return out;
}

module.exports = {
  IGNORE_SCRIPTS_FLAG, NO_IGNORE_SCRIPTS_FLAG, ENV_PASSTHROUGH,
  defaultSpec, validate, build, childEnv,
};
