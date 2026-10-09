'use strict';

const net = require('node:net');
const spawnOS = require('../os/spawn');
const procOS = require('../os/process');
const execPath = require('../os/exec-path');
const runtimeContract = require('../contract/runtime');
const service = require('../os/service').current();
const { VERSION_RE } = require('../../shared/version');
const OUTCOME = require('../../shared/outcome');
const ref = require('./registry-ref');
const policies = require('./policies');
const input = require('../util/input');

// 安全不变量（W2/O-16 收口）：安装期一律禁用生命周期脚本。
// 此前 `--ignore-scripts` 只出现在「无 commandTemplate」分支 ⇒ 用户配了 commandTemplate 时安全姿态**静默消失**，
// 同一行为两条路径给出不同安全语义（典型补丁逻辑）。现提升为两条路径共用的强制常量：
// 模板分支若已显式写了该开关（或用户显式写了 --no-ignore-scripts）则尊重用户，否则补上。
const IGNORE_SCRIPTS_FLAG = '--ignore-scripts';

const PKG_NAME_RE = input.PKG_NAME_RE;
const BAD_ARGV_CHAR_RE = input.ARGV_UNSAFE_RE;
const WIN_DRIVE_ABS_RE = input.WIN_ABS_PATH_RE;

const INFLIGHT_NPM = new Set();

function inflightNpmCount() { return INFLIGHT_NPM.size; }

function killInflightNpm(reason) {
  const hs = [...INFLIGHT_NPM];
  for (const h of hs) { try { h.abort(reason); } catch {  } }
  return hs.length;
}

function runNpmInstall(opts) {
  const o = opts || {};
  const action = (o.action === undefined || o.action === null) ? 'install' : String(o.action);
  const bad = (r) => ({ ok: false, error: null, output: [], exitCode: null, timedOut: false, aborted: false, ...r });
  const fail = (error) => Promise.resolve(bad({ error }));
  if (action !== 'install' && action !== 'uninstall') return fail('runNpmInstall: 未知 action（只接受 install/uninstall）: ' + action.slice(0, 40));
  const pkg = o.pkg || '@deepseek-ai/dsh';
  if (action === 'install' && !o.version) return fail('runNpmInstall: 缺少 version（必须显式携带）');
  if (!PKG_NAME_RE.test(pkg)) return fail('runNpmInstall: 非法包名（字符集白名单不通过）: ' + String(pkg).slice(0, 80));
  if (action === 'install' && !VERSION_RE.test(String(o.version))) return fail('runNpmInstall: 非法版本号（须为严格 semver）: ' + String(o.version).slice(0, 80));
  let argv;
  const contractLauncher = runtimeContract.npmLauncher();
  // 启动形态注入必须整对接管：只换程序会让假解释器去跑契约的 npm-cli.js。
  const launcher = (o.launcher && o.launcher.program)
    ? { program: String(o.launcher.program), args: Array.isArray(o.launcher.args) ? o.launcher.args.map(String) : [] }
    : contractLauncher;
  let bin = launcher.program;
  if (Array.isArray(o.commandTemplate) && o.commandTemplate.length) {
    argv = o.commandTemplate.map((s) => String(s).replace(/{pkg}/g, pkg).replace(/{version}/g, o.version || '').replace(/{prefix}/g, o.prefix || ''));
    const fromTemplate = argv[0] !== 'npm';
    bin = fromTemplate ? argv[0] : launcher.program;
    argv = (fromTemplate ? [] : launcher.args).concat(argv.slice(1));
    if (!fromTemplate && launcher.source === 'path' && bin === 'npm' && !execPath.resolveExecutable('npm')) {
      return fail('runNpmInstall: 未找到可执行的 npm（commandTemplate[0]="npm" 解析失败）');
    }
    // 安全不变量对模板分支同样成立：未显式声明则补上（用户显式写了 --no-ignore-scripts 则尊重用户）。
    if (!argv.includes(IGNORE_SCRIPTS_FLAG) && !argv.includes('--no-ignore-scripts')) argv.push(IGNORE_SCRIPTS_FLAG);
    for (const a of argv) {
      // win32 盘符绝对路径整体豁免（反斜杠为路径分隔符），其余项零豁免。
      if (BAD_ARGV_CHAR_RE.test(String(a)) && !WIN_DRIVE_ABS_RE.test(String(a))) {
        return fail('runNpmInstall: commandTemplate 替换后含禁用字符（空白/shell 元字符）: ' + String(a).slice(0, 80));
      }
    }
  } else {
    argv = [...launcher.args, action, '-g'];
    if (action === 'install') argv.push('--no-audit', '--no-fund');
    argv.push(IGNORE_SCRIPTS_FLAG);
    if (o.prefix) {
      const pv = input.prefixViolation(o.prefix);
      if (pv) return fail('runNpmInstall: ' + pv);
      argv.push('--prefix', String(o.prefix));
    }
    argv.push(action === 'install' ? pkg + '@' + o.version : pkg);
  }
  const envVars = runtimeContract.withPath(process.env);
  if (o.registry && action === 'install') {
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
      try { procOS.killTree(child.pid, 'SIGKILL', () => {}, { ownGroup: true }); } catch {  }
      try { child.kill('SIGKILL'); } catch {  }
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
        if (o.onLine) { try { o.onLine(t.slice(0, 200)); } catch {  } }
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
      try { socket.destroy(); } catch {  }
      resolve(ok);
    };
    socket.setTimeout(1500);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

// 健康验证须端口 + systemd 单元 active 双查并留稳定期：只探端口会把「先监听后崩溃」误判成功。
async function waitPortHealthy(opts) {
  const o = opts || {};
  const host = o.host || '127.0.0.1';
  const port = Number(o.port);
  if (!Number.isInteger(port) || port <= 0) return { ok: false, reason: 'waitPortHealthy: 非法端口 ' + o.port };
  const unit = o.unit || null;
  const stabilityMs = o.stabilityMs !== undefined ? o.stabilityMs : 15000;
  // isUnitActive 现返回 Outcome 三态。此处**只接受 ok**：
  // 此前 null（未知）是真值 ⇒ "端口有人监听"被当成"我们的实例在跑" ⇒ 升级校验假成功、不回滚（P0）。
  const ctx = { port, unit };
  if (o.pidFile !== undefined) ctx.pidFile = o.pidFile;
  if (Array.isArray(o.anchors)) ctx.anchors = o.anchors;
  // 单元活跃判据：端口 + 单元 active 双查（只探端口会把「先监听后崩溃」误判成功，P0）。
  // 但 portable 档下，调用方若只给端口（unit/pidFile/锚点都缺失），isUnitActive 只能给 UNKNOWN——
  // 那是「判不出身份」，不是「确定不活跃」；此时应以端口监听为准（孤端口进程也视为健康）。
  // 只有显式带了单元身份（unit 或 pidFile/anchors）时，才要求 isUnitActive 为 OK（真值失败 ⇒ 明确不活跃）。
  const unitActive = () => {
    if (!unit && !ctx.pidFile && (!Array.isArray(ctx.anchors) || !ctx.anchors.length)) {
      return true; // 无单元身份可查：端口监听即健康
    }
    const r = service.isUnitActive(unit, ctx);
    return OUTCOME.isOk(r);
  };
  const deadline = Date.now() + (o.timeoutMs || 60000);
  while (Date.now() < deadline) {
    if ((await portListening(host, port)) && unitActive()) {
      const remain = deadline - Date.now();
      const wait = Math.max(0, Math.min(stabilityMs, remain));
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
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
  killInflightNpm,
  inflightNpmCount,
};
