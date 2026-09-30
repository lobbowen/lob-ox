'use strict';

// 域：原生 DSH（app/native）—— npm 调用（IO：exec / spawn 经 platform 统一封装）。
// npm 的启动形态经 host._npmBin/_npmBinArgs 构造期注入，未注入时统一取运行期契约。

const ex = require('../../platform/util/exec');
const runtimeContract = require('../../platform/contract/runtime');

/** npm 启动形态 `{ program, args }`：必须成对取值、同源一次解析，绝不拆用。
 *  契约可能是「node + 包内 npm-cli.js」——只取 program 会降级成裸跑 node，只取 args 会把参数塞给别的解释器；
 *  program 走 ambient PATH 在 GUI 环境（PATH 里没有 nvm/fnm 的 npm）下安装/卸载/探测 root 全失败。
 *  注入即接管整对：测试注入 fake npm 时不继承契约前缀参数，否则假解释器会去跑真 npm-cli.js（真实副作用）。 */
function npmLaunch(host) {
  const h = host || {};
  if (h._npmBin) {
    return { program: h._npmBin, args: Array.isArray(h._npmBinArgs) ? h._npmBinArgs.slice() : [] };
  }
  const l = runtimeContract.npmLauncher();
  return { program: l.program, args: l.args };
}

/** 优先注入值（测试）。 */
/** npm 全局根（异步：HTTP 处理路径都在事件循环上，同步 root -g 最长冻结 15s）。
 *  opts 透传给执行器（超时口径由调用方定）：环境表单的读路径必须远小于默认 15s，
 *  否则一次面板刷新就吃掉用户可见的动作预算；拿不到即 null，由表单如实标「未测到」。 */
async function resolveNpmRoot(host, opts) {
  if (host.npmRoot) return host.npmRoot;
  const l = npmLaunch(host);
  const r = await ex.runOutAsync(l.program, l.args.concat(['root', '-g']), opts || undefined);
  return r ? r.trim() : null;
}

/** 环境检查（异步并行探测）：三个子进程各自有界、互不串行叠加。 */
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

/** 最新版本 + **给出该版本的那个镜像源**（统一分发通道，结构化）。第三方包语义：latest 通道优先，
 *  缺失/非法才回落 versions 最高——由 dist.fetchVersionInfo 保证，调用侧勿自行取 versions 最高。
 *  origin 必须一起返回：调用方另选一次源，就会「装的是 A 源查到的版本、字节从 B 源下」。 */
async function latestVersion(host) {
  if (!host.dist || !host.config.packageName) throw new Error('分发服务未初始化，无法查询最新版本');
  const channel = host.config.releaseChannel || 'npm';
  return host.dist.fetchVersionInfo(host.config.packageName, channel);
}

/** 选最快可达镜像（网络环境自适应）。只要本次用的那一个源；顺延序列在 dist 侧。 */
async function selectRegistry(host) {
  if (!host.dist) return null;
  try { return await host.dist.registryOrigin(true); } catch { return null; }
}

/** npm 动作执行（唯一入口 = dist.runNpmInstall）：装/升/回滚/卸载共用同一个执行器。
 *  本函数只把 host 状态翻译成执行器入参；超时、杀树、在途记账、镜像注入全在执行器那侧。
 *  超时缺省值不写在这里（platform 的策略表是唯一定量），只传配置覆盖值。 */
function runNpm(host, opts) {
  const a = (opts && opts.action) || 'install';
  const verb = a === 'uninstall' ? '卸载' : '安装';
  if (!host.dist) return Promise.resolve({ ok: false, error: 'dist 分发服务不可用，无法' + verb, output: [] });
  const tpl = a === 'install' ? host.config.installCommandTemplate : null;
  return host.dist.runNpmInstall({
    action: a,
    pkg: host.config.packageName || '@deepseek-ai/dsh',
    version: opts && opts.version,
    // 前缀单源：装与卸必须落在同一个全局前缀，否则「卸载成功」而包还在原地。
    prefix: host.npmRoot || null,
    registry: opts && opts.registry,
    // 只在显式注入过 npm 形态时接管启动形态；生产留空，由执行器按运行期契约解析一次。
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
