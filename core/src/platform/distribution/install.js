'use strict';

// npm 动作执行 + 端口健康验证（IO）。版本查询在 version-check.js，本文件只负责「把 npm 动作安全地跑完」。
// 全具名导出、显式收参，不碰跨文件 this。

const net = require('node:net');
const spawnOS = require('../os/spawn');
const procOS = require('../os/process');
const execPath = require('../os/exec-path');
const runtimeContract = require('../contract/runtime');
const service = require('../os/service').current();
const { VERSION_RE } = require('../../shared/version');
const ref = require('./registry-ref');
const policies = require('./policies');
const input = require('../util/input');

/** 字符集白名单尺子取自 platform/util/input 单源，此处仅同名转发导出
 *  （npm-resolution 门禁直接断言 inst.PKG_NAME_RE，尺子只有一把）：
 *  pkg/version 会流入 argv 与 commandTemplate 的 {pkg}/{version} 替换，不进白名单就是注入面。 */
const PKG_NAME_RE = input.PKG_NAME_RE;
const BAD_ARGV_CHAR_RE = input.ARGV_UNSAFE_RE;
const WIN_DRIVE_ABS_RE = input.WIN_ABS_PATH_RE;

/** 在途 npm 安装句柄（D-10）。装/卸/升级全部经 runNpmInstall，故本集合就是「守卫内不可见的
 *  外部写入者」清单。子进程 detached（自成进程组），守卫退出后不会随之消亡——关停必须先中止它们。 */
const INFLIGHT_NPM = new Set();

/** 在途 npm 任务数（关停路径据此决定是否留痕/发事件）。 */
function inflightNpmCount() { return INFLIGHT_NPM.size; }

/** 中止全部在途 npm 子进程（连同其进程组），并让对应 Promise 以 ok:false,aborted:true 收口。
 *  @returns {number} 被中止的任务数 */
function killInflightNpm(reason) {
  const hs = [...INFLIGHT_NPM];
  for (const h of hs) { try { h.abort(reason); } catch { /* 已收口：不阻断关停 */ } }
  return hs.length;
}

/** npm 动作执行器（安装/升级/回滚/卸载的唯一出口）：入参白名单 / 镜像注入 / 超时看门狗 /
 *  行日志 / 退出码 / 进程树清理 / 在途记账。
 *  @param {object} opts { action?:'install'|'uninstall'（默认 install）, pkg,
 *           version（action=install 时必须显式）, prefix（沙箱）, registry（仅 install 消费）,
 *           timeoutMs, detached, launcher（{program,args} 整对注入，测试用）, commandTemplate, onLine }
 *  @returns Promise<{ ok, error, output, exitCode, timedOut, aborted }> */
function runNpmInstall(opts) {
  const o = opts || {};
  const action = (o.action === undefined || o.action === null) ? 'install' : String(o.action);
  // 结果形状只有一个：任何一条出口都带全 exitCode/timedOut/aborted，调用方无需分辨「字段缺席」
  // 与「字段为假」—— 卸载的 K10 语义（保留 manifest、可重试）就靠这三位的确定性成立。
  const bad = (r) => ({ ok: false, error: null, output: [], exitCode: null, timedOut: false, aborted: false, ...r });
  const fail = (error) => Promise.resolve(bad({ error }));
  if (action !== 'install' && action !== 'uninstall') return fail('runNpmInstall: 未知 action（只接受 install/uninstall）: ' + action.slice(0, 40));
  const pkg = o.pkg || '@deepseek-ai/dsh';
  if (action === 'install' && !o.version) return fail('runNpmInstall: 缺少 version（必须显式携带）');
  // 入参白名单（fail-closed）：pkg/version 来自配置/registry 返回值，任何一环被污染
  // 都会经 argv 或模板替换直达 spawn —— 非法字符（空白/shell 元字符）在构造命令前即拒。
  if (!PKG_NAME_RE.test(pkg)) return fail('runNpmInstall: 非法包名（字符集白名单不通过）: ' + String(pkg).slice(0, 80));
  if (action === 'install' && !VERSION_RE.test(String(o.version))) return fail('runNpmInstall: 非法版本号（须为严格 semver）: ' + String(o.version).slice(0, 80));
  // 唯一 npm 动作执行器：commandTemplate 支持完整替换命令（测试/特殊环境注入 fake-npm 等）。
  let argv;
  // 经统一解析口拿启动形态（程序 + 前缀参数成对）：win32 下是 npm.cmd；官方分发包只带
  // 包内 JS 时是 `node <npm-cli.js>`。只取程序会把后者降级成裸跑 node（含糊失败）。
  const contractLauncher = runtimeContract.npmLauncher();
  // 启动形态的注入口（app 层 npmLaunch 认识 host._npmBin）：注入即**整对**接管，只换程序会
  // 让假解释器去跑契约的 npm-cli.js（真实副作用）；未注入时仍由上面的解析口取一次，不拆两份事实。
  const launcher = (o.launcher && o.launcher.program)
    ? { program: String(o.launcher.program), args: Array.isArray(o.launcher.args) ? o.launcher.args.map(String) : [] }
    : contractLauncher;
  let bin = launcher.program;
  if (Array.isArray(o.commandTemplate) && o.commandTemplate.length) {
    argv = o.commandTemplate.map((s) => String(s).replace(/{pkg}/g, pkg).replace(/{version}/g, o.version || '').replace(/{prefix}/g, o.prefix || ''));
    // 模板首项通常就是逻辑名 'npm'，同样需要跨平台解析；仅在首项恰为逻辑名时解析。
    const fromTemplate = argv[0] !== 'npm';
    bin = fromTemplate ? argv[0] : launcher.program;
    // 契约前缀参数只属于契约程序；模板自带解释器（如 node /tmp/fake.js）时不得前插。
    argv = (fromTemplate ? [] : launcher.args).concat(argv.slice(1));
    // 模板首项为逻辑名 'npm' 时走统一解析口并在解析失败时 fail-closed（两平台语义一致）；
    // 首项非 'npm' 时按字面量作为程序交给 spawn（走其自身 PATH 语义），无解析口预校验，
    // 唯一防线是下方逐项禁用字符集闸。
    if (!fromTemplate && launcher.source === 'path' && bin === 'npm' && !execPath.resolveExecutable('npm')) {
      return fail('runNpmInstall: 未找到可执行的 npm（commandTemplate[0]="npm" 解析失败）');
    }
    for (const a of argv) {
      // WIN_DRIVE_ABS_RE：win32 盘符绝对路径整体豁免（`\\` 为路径分隔符）；其余项零豁免。
      if (BAD_ARGV_CHAR_RE.test(String(a)) && !WIN_DRIVE_ABS_RE.test(String(a))) {
        return fail('runNpmInstall: commandTemplate 替换后含禁用字符（空白/shell 元字符）: ' + String(a).slice(0, 80));
      }
    }
  } else {
    argv = [...launcher.args, action, '-g'];
    if (action === 'install') argv.push('--no-audit', '--no-fund');
    // 两个动作都不执行包内生命周期脚本：安装期 pre/post 让 registry 内容（含镜像被投毒场景）
    // 以守卫权限跑任意代码；卸载期的 pre/postuninstall 同样是**待删包自带**的代码。
    argv.push('--ignore-scripts');
    // prefix 与 pkg/version 同源（配置/沙箱目录）、同样直达 spawn，故同样过闸；
    // 过的是路径形态尺而非 argv 字符集尺，理由见 input.prefixViolation。
    if (o.prefix) {
      const pv = input.prefixViolation(o.prefix);
      if (pv) return fail('runNpmInstall: ' + pv);
      argv.push('--prefix', String(o.prefix));
    }
    // 卸载只点名包（无版本）：`npm uninstall -g <pkg>` 不读 registry，删的是当前前缀里装的那份。
    argv.push(action === 'install' ? pkg + '@' + o.version : pkg);
  }
  // 契约 PATH 注入（nodeBinDir 首位）：内核自身执行的 npm 也必须能找到 node。
  const envVars = runtimeContract.withPath(process.env);
  if (o.registry && action === 'install') {
    // 注入 npm 的镜像基址过同一道形态闸（registryEnvPair 单口）：`file://`、凭证/查询/片段夹带
    // 都是攻击面。**允许带 path** —— 华为云/腾讯云镜像就是这个形态，npm_config_registry 本就接受
    // 完整基址；把它判死会让下载落到与选源不同的 registry。
    // 卸载不注入：不联网的动作带上镜像地址，只会把删除失败诊断成 registry 问题。
    const rp = ref.registryEnvPair(o.registry);
    if (!rp.ok) return fail('runNpmInstall: 非法 registry 基址（' + rp.violation + '）: ' + String(o.registry).slice(0, 80));
    Object.assign(envVars, rp.env);
  }
  const timeoutMs = Number(o.timeoutMs) > 0 ? Number(o.timeoutMs) : policies.NPM_TIMEOUT_MS[action];
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnOS.piped(bin, argv, { env: envVars, detached: o.detached !== false });
    } catch (e) {
      return resolve(bad({ error: e.message }));
    }
    const out = [];
    // 在途 npm 子进程必须可被守卫主动中止：detached 子进程在守卫退出/被 8s 强杀后仍会
    //   继续跑，新守卫 boot 时旧 npm 仍在写 node_modules 与全局前缀 —— 无人等待、无人记账
    //   的并发写入者，正是半成品安装的来源。关停路径经 killInflightNpm() 收口。
    let settled = false;
    const finish = (r) => {
      if (settled) return;
      settled = true;
      INFLIGHT_NPM.delete(handle);
      clearTimeout(timer);
      resolve(r);
    };
    const killTree = () => {
      if (!child || child.exitCode !== null) return;
      // 必须走 platform/os/process 的整树终止（win 用 taskkill /T /F）：Windows 没有进程组
      //   语义，负 pid 组信号只杀得到 npm.cmd 那层壳，真正写 node_modules/全局前缀的 node
      //   孙进程照旧存活 —— 正是本条（D-10）要消灭的「无人记账的外部写入者」。
      //   ownGroup:true —— 子进程以 detached 起，必为自身进程组组长（POSIX 组信号安全）。
      try { procOS.killTree(child.pid, 'SIGKILL', () => {}, { ownGroup: true }); } catch { /* 尽力而为 */ }
      try { child.kill('SIGKILL'); } catch { /* 已退出 */ }
    };
    const handle = {
      pid: child.pid,
      abort: (reason) => {
        killTree();
        finish(bad({ aborted: true, error: 'npm ' + action + ' 被中止: ' + (reason || 'guard-exit'), output: out }));
      },
    };
    const timer = setTimeout(() => {
      killTree();
      finish(bad({ timedOut: true, error: 'npm ' + action + ' 超时（' + Math.round(timeoutMs / 1000) + 's）已终止', output: out }));
    }, timeoutMs);
    INFLIGHT_NPM.add(handle);
    const onLine = (buf) => {
      for (const l of String(buf).split(/\r?\n/)) {
        const t = l.trim();
        if (!t) continue;
        out.push(t.slice(0, 200));
        if (o.onLine) { try { o.onLine(t.slice(0, 200)); } catch { /* 回调失败不阻断 */ } }
      }
    };
    child.stdout.on('data', onLine);
    child.stderr.on('data', onLine);
    child.on('error', (e) => { finish(bad({ error: e.message, output: out })); });
    child.on('exit', (code) => {
      const c = code === null ? -1 : code;
      finish({ ok: c === 0, error: c === 0 ? null : 'npm ' + action + ' 退出码 ' + c, output: out, exitCode: c, timedOut: false, aborted: false });
    });
  });
}

function portListening(host, port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      try { socket.destroy(); } catch { /* 已关闭 */ }
      resolve(ok);
    };
    socket.setTimeout(1500);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

/** 健康验证器（统一端口 + systemd 单元 + 稳定期）。
 *
 *  DSH 进程可能先监听端口、随后因插件兼容崩溃，只探测端口会误判成功 ——
 *  必须同时检查 systemd 单元仍 active，并留稳定期防「延迟崩溃」。 */
async function waitPortHealthy(opts) {
  const o = opts || {};
  const host = o.host || '127.0.0.1';
  const port = Number(o.port);
  if (!Number.isInteger(port) || port <= 0) return { ok: false, reason: 'waitPortHealthy: 非法端口 ' + o.port };
  const unit = o.unit || null;
  const stabilityMs = o.stabilityMs !== undefined ? o.stabilityMs : 15000;
  // 平台层判定（无单元视为通过）。portable 档拿不到单元概念，以 {port} 反查监听进程为活跃锚——
  // 与下方 portListening 同锚，故对 portable 该检查退化为端口持续在线（正确语义）；systemd 档忽略 ctx 附加字段。
  const unitActive = () => service.isUnitActive(unit, { port });
  const deadline = Date.now() + (o.timeoutMs || 60000);
  while (Date.now() < deadline) {
    if ((await portListening(host, port)) && unitActive()) {
      // 稳定期：用**剩余预算**做缩短的稳定期复检（慢启动实例不得被误判失败，也不超 deadline）。
      const remain = deadline - Date.now();
      const wait = Math.max(0, Math.min(stabilityMs, remain));
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      // 稳定期复查必须同时复检端口：只查单元会漏掉进程在稳定期内崩溃（端口已空）。
      if ((await portListening(host, port)) && unitActive()) return { ok: true };
    }
    const remain = deadline - Date.now();
    if (remain <= 0) break;
    await new Promise((r) => setTimeout(r, Math.min(2000, remain)));
  }
  return { ok: false, reason: '端口 ' + port + ' 未就绪' + (unit ? ' 或单元 ' + unit + ' 未保持 active' : '') };
}

module.exports = {
  PKG_NAME_RE,
  BAD_ARGV_CHAR_RE,
  WIN_DRIVE_ABS_RE,
  runNpmInstall,
  waitPortHealthy,
  // 在途 npm 的记账/中止出口（关停路径经 platform/distribution 门面 re-export）
  killInflightNpm,
  inflightNpmCount,
};
