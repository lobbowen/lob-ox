'use strict';

const ex = require('../../platform/util/exec');
const runtimeContract = require('../../platform/contract/runtime');

function npmLaunch(host) {
  const h = host || {};
  if (h._npmBin) {
    return { program: h._npmBin, args: Array.isArray(h._npmBinArgs) ? h._npmBinArgs.slice() : [] };
  }
  const l = runtimeContract.npmLauncher();
  return { program: l.program, args: l.args };
}

async function resolveNpmRoot(host, opts) {
  if (host.npmRoot) return host.npmRoot;
  const l = npmLaunch(host);
  const r = await ex.runOutAsync(l.program, l.args.concat(['root', '-g']), opts || undefined);
  return r ? r.trim() : null;
}

async function checkEnvironment(host) {
  const errors = [];
  const l = npmLaunch(host);
  const [nv, npmv, npmRoot] = await Promise.all([
    ex.runOutAsync('node', ['--version']),
    ex.runOutAsync(l.program, l.args.concat(['--version'])),
    resolveNpmRoot(host),
  ]);
  if (!nv || !nv.trim()) errors.push('node 未安装或不可执行');
  if (!npmv || !npmv.trim()) errors.push('npm 未安装或不可执行');
  return { ok: errors.length === 0, errors, npmRoot };
}

async function latestVersion(host) {
  if (!host.dist || !host.config.packageName) throw new Error('分发服务未初始化，无法查询最新版本');
  const channel = host.config.releaseChannel || 'npm';
  return host.dist.fetchVersionInfo(host.config.packageName, channel);
}

async function selectRegistry(host) {
  if (!host.dist) return null;
  try { return await host.dist.registryOrigin(true); } catch { return null; }
}

function runNpm(host, opts) {
  const a = (opts && opts.action) || 'install';
  const verb = a === 'uninstall' ? '卸载' : '安装';
  if (!host.dist) return Promise.resolve({ ok: false, error: 'dist 分发服务不可用，无法' + verb, output: [] });
  const tpl = a === 'install' ? host.config.installCommandTemplate : null;
  return host.dist.runNpmInstall({
    action: a,
    pkg: host.config.packageName || '@deepseek-ai/dsh',
    version: opts && opts.version,
    prefix: host.npmRoot || null,
    registry: opts && opts.registry,
    launcher: host._npmBin ? npmLaunch(host) : null,
    commandTemplate: Array.isArray(tpl) && tpl.length ? tpl : null,
    timeoutMs: a === 'uninstall' ? host.config.uninstallTimeoutMs : host.config.upgradeTimeoutMs,
    onLine: (l) => {
      host._appendUpgradeLog(l);
      if (host.installing) host._appendInstallLog(l);
    },
  });
}

module.exports = { npmLaunch, resolveNpmRoot, checkEnvironment, latestVersion, selectRegistry, runNpm };
