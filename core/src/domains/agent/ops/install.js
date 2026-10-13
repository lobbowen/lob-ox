'use strict';

// agent 安装（五件套之二）。
//
// 从两处并行实现收拢：
//   domains/instance/ops/dsh-install.js  沙箱化：npm --prefix <每实例 installDir>
//   app/native/npm.js                   原  生：npm --prefix <共享 npmRoot>
//
// 收拢的关键：两者本质是同一件事——「把 agent 包装到某个 prefix 下」。
// 差别只在 prefix 从哪来，而 prefix 的判据已经在 model.installDirOf 里回答过。
// 故本模块不出现 if (kind === 'sandbox') 分支：调用方传入 prefix，本模块只执行。
//
// 另一处收拢：原两份实现各自硬编码 '@deepseek-ai/dsh'。
// 本模块把包名改为入参（product.pkg），agent 域不绑定 DSH。

const fs = require('node:fs');
const path = require('node:path');

const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;

// 日志过滤：npm 的 warn/notice/deprecated 对用户无信息量，原实现即过滤，保留同一口径。
const NOISE_RE = /unknown user config|npm warn|deprecated|^\$|npm notice/i;

/**
 * 写一行安装日志。返回是否放行——调用方（onLine 桥）据此决定要不要
 * 把自己的回调也点亮。噪声在此单一处过滤，不漏给任何一层。
 */
function pushLog(sink, line) {
  const raw = String(line == null ? '' : line);
  let emitted = false;
  for (const ln of raw.split(/\r?\n/)) {
    const l = ln.trim();
    if (!l) continue;
    if (NOISE_RE.test(l)) continue;
    emitted = true;
    if (!sink) continue;
    const t = new Date().toISOString().slice(11, 19);
    try {
      sink.push('[' + t + '] ' + l);
      if (sink.length > 60) sink.shift();
    } catch {  }
  }
  return emitted;
}

/**
 * 把 agent 包装到 prefix 下。
 *
 * @param {object} spec
 * @param {object} spec.product   { pkg: '@scope/name' } —— 包名由调用方给，本模块不假定
 * @param {string} spec.prefix    安装目标前缀（沙箱=每实例 installDir；原生=共享 npmRoot）
 * @param {string} spec.version   目标版本（null = latest）
 * @param {string} spec.registry  镜像源
 * @param {object} spec.dist      统一分发服务（提供 runNpmInstall / fetchNpmLatest）
 * @param {Function} [spec.onLine] 逐行日志回调
 * @returns {Promise<{ok:boolean,error:string|null,version:string|null}>}
 */
async function installToPrefix(spec) {
  const s = spec || {};
  const product = s.product || {};
  const pkg = product.pkg;
  if (!pkg) return { ok: false, error: '未指定 agent 包名（product.pkg）', version: null };
  if (!s.prefix) return { ok: false, error: '未指定安装前缀（prefix）', version: null };
  if (!s.dist) return { ok: false, error: 'dist 分发服务不可用', version: null };

  pushLog(s.log, '安装 ' + pkg + (s.version ? '@' + s.version : '@latest') + ' → ' + s.prefix);

  // 目录预备：沙箱形态每实例一份，原生形态是共享 prefix（可能已存在）。
  try { fs.mkdirSync(s.prefix, { recursive: true }); } catch {  }

  let res;
  try {
    res = await s.dist.runNpmInstall({
      pkg,
      version: s.version || undefined,
      prefix: s.prefix,
      registry: s.registry || undefined,
      launcher: s.launcher || null,
      commandTemplate: Array.isArray(s.commandTemplate) && s.commandTemplate.length ? s.commandTemplate : null,
      timeoutMs: s.timeoutMs || INSTALL_TIMEOUT_MS,
      onLine: (l) => {
        // 先过噪声过滤，放行才点亮调用方回调——否则调用方收到的是未过滤原文。
        if (pushLog(s.log, l) && typeof s.onLine === 'function') {
          try { s.onLine(l); } catch {  }
        }
      },
    });
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e), version: null };
  }
  if (!res || res.ok !== true) {
    return { ok: false, error: (res && res.error) || '安装失败', version: null };
  }
  return { ok: true, error: null, version: s.version || null };
}

/**
 * 读已安装版本：从 prefix 下的 node_modules/<pkg>/package.json 取。
 * 沙箱与原生都走这条——差别只在 prefix，已由调用方解决。
 */
function installedVersionAt(prefix, pkg) {
  if (!prefix || !pkg) return null;
  const pkgJson = path.join(prefix, 'node_modules', pkg, 'package.json');
  try {
    if (!fs.existsSync(pkgJson)) return null;
    const j = JSON.parse(fs.readFileSync(pkgJson, 'utf8'));
    return (j && typeof j.version === 'string') ? j.version : null;
  } catch { return null; }
}

/**
 * 查询最新版本。带 30s TTL 缓存——原两份实现各有一份 _latestDsh / dist 层缓存，
 * 此处收拢为一处，且 TTL 与超时都可配。
 */
function createLatestResolver(dist, opts) {
  const ttlMs = (opts && opts.ttlMs) || 30000;
  let cache = null;
  return async function latest(pkg) {
    if (cache && cache.pkg === pkg && Date.now() - cache.at < ttlMs) return cache.value;
    let r = { ok: false, version: null, origin: null, error: 'dist 分发服务不可用' };
    if (dist && pkg) {
      try { r = await dist.fetchNpmLatest(pkg); }
      catch (e) { r = { ok: false, version: null, origin: null, error: (e && e.message) || String(e) }; }
    }
    if (r && r.ok && r.version) cache = { pkg, at: Date.now(), value: r };
    return r;
  };
}

/**
 * 环境自检：node/npm 是否可用。
 * 从 app/native/npm.js 的 checkEnvironment 收拢，但不绑 host——
 * 调用方给 npmLauncher（来自 runtimeContract），本模块只执行。
 */
async function checkEnvironment(npmLauncher) {
  const ex = require('../../../platform/util/exec');
  const errors = [];
  const l = npmLauncher || {};
  const program = l.program;
  const args = Array.isArray(l.args) ? l.args : [];
  if (!program) return { ok: false, errors: ['npm 启动器未就绪（runtimeContract 未解析）'], npmRoot: null };
  const [nv, npmv, npmRoot] = await Promise.all([
    ex.runOutAsync('node', ['--version']).catch(() => null),
    ex.runOutAsync(program, args.concat(['--version'])).catch(() => null),
    ex.runOutAsync(program, args.concat(['root', '-g'])).catch(() => null),
  ]);
  if (!nv || !nv.trim()) errors.push('node 未安装或不可执行');
  if (!npmv || !npmv.trim()) errors.push('npm 未安装或不可执行');
  return { ok: errors.length === 0, errors, npmRoot: (npmRoot || '').trim() || null };
}

module.exports = { installToPrefix, installedVersionAt, createLatestResolver, checkEnvironment, INSTALL_TIMEOUT_MS };