'use strict';

// 服务管理器抽象（Provider 分派）。铁律：平台无关域（domains/*、supervisor）不得直接调用 systemctl/launchctl/schtasks，一律经本模块；未实现的能力显式抛 CapabilityError，绝不静默失败。
// 分派口径（实测不写死）：linux 且有 systemd-run -> systemd（cgroup 硬档，set-property 动态下发）；linux 无 user-systemd（容器/WSL1）-> portable；darwin / win32 -> portable（采样式限额 supervise 档，Job Object / launchd plist 属定案范围外）；
// 未知平台 -> NONE（显式失败；能力档位 sandboxLaunch=false 在域层入口即挡）。

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const exec = require('../util/exec');
const input = require('../util/input');
const execPath = require('./exec-path');
const { portable } = require('./portable');

/** 平台不具备该能力时抛出（调用方据此给出明确提示，而非 catch 后误报「启动失败/端口冲突」）。 */
class CapabilityError extends Error {
  constructor(msg) { super(msg); this.name = 'CapabilityError'; this.code = 'CAPABILITY_UNSUPPORTED'; }
}

const PLATFORM = process.platform;

function run(cmd, args, opts) {
  // 经统一执行器（默认 15s 硬超时 + SIGKILL，防 systemd/dbus 挂起时无限阻塞）；调用方 timeoutMs 仍生效。
  // 必须原样透传 opts、不得强制 stdio ignore：isUnitActive 等要读 stdout 判单元状态，丢输出则
  // 就绪判定与「仍活跃则不删」保护失效。
  return exec.run(cmd, args, opts || {});
}

/** systemd 单元名字符集白名单（fail-closed）。
 *  unit 名唯一来源是 'dsh-web@' + inst.id，而 inst.id 从 instances.json 原样载回——该文件
 *  沙箱侧/人工可改，属信任边界之外：名字含 /、..、空白或控制符即可把命令指向其它 *.service、
 *  把删除指向任意路径。判据：1..128 字符，仅字母数字 + : - _ . @，须带 .service 后缀或无后缀。 */
const UNIT_NAME_RE = input.UNIT_NAME_RE;
// 判定体即 E-4 单源的 input.unitNameViolation（保留本模块同名导出：exec-return-contract A4b
// 按 svcMod.unitNameViolation 做行为级判定，且各 Provider 在调用前就地问闸）。
function unitNameViolation(unit) { return input.unitNameViolation(unit); }

const systemd = {
  kind: 'systemd',
  supportsUnits: true,
  supportsTransient: true,
  daemonReload() { try { return run('systemctl', ['--user', 'daemon-reload'], { timeoutMs: 15000 }) !== null; } catch { return false; } },
  stopUnit(unit, opts) {
    if (unitNameViolation(unit)) return false; // 非法名绝不进 systemctl argv
    const o = opts || {};
    try { return run('systemctl', ['--user', 'stop', unit], { timeoutMs: o.timeoutMs || 15000 }) !== null; }
    catch { return false; } // 停止失败不抛（调用方多为 best-effort 清理）；可经 isUnitActive 复核
  },
  // run() 失败返回 null 而不抛，try/catch 包裹会恒返回 true；如实回传成败。
  resetFailed(unit) {
    if (unitNameViolation(unit)) return false;
    return run('systemctl', ['--user', 'reset-failed', unit], { timeoutMs: 10000 }) !== null;
  },
  /** 单元活跃判定（三态）：确认 active -> true；确认不活跃 -> false；查询未完成 -> null（未知）。
   *  run() 失败只返回 null，「查询未完成」不可折成 false：instance/ops.js 删除数据目录前
   *  按「!== false 才放行删除」消费本函数，折假即超时窗口内误删沙箱数据。 */
  isUnitActive(unit) {
    if (!unit) return true; // 无单元约束 -> 视为通过（调用方语义）
    if (unitNameViolation(unit)) return false; // 非法名不可能由内核启动，恒判「确认不活跃」
    try {
      const r = exec.runDetail('systemctl', ['--user', 'is-active', unit], { timeoutMs: 8000 });
      if (r.timedOut) return null; // 超时 -> 查询未完成，未知（绝不当作「不活跃」）
      const state = String(r.stdout || '').trim(); // is-active 把状态打到 stdout（非零退出时同样有）
      if (state === 'active') return true;
      if (state || r.code !== null) return false; // systemctl 已作答 -> 确认不活跃
      return null; // 未能执行（如 ENOENT）-> 未知
    } catch { return null; }
  },
  transientUnitFile(unit) {
    if (unitNameViolation(unit)) return null; // 非法名不再生成路径（调用方据此跳过 unlink）
    let uid = 0;
    try { uid = os.userInfo().uid; } catch { /* 受限环境：退回 /run/user/0 */ }
    const rt = process.env.XDG_RUNTIME_DIR || ('/run/user/' + uid);
    return path.join(rt, 'systemd', 'transient', unit + '.service');
  },
  /** 清理 stale transient 单元：stop/reset-failed/删单元文件/daemon-reload。
   *  必须 reload：删除文件后 systemd 仍缓存该单元为 loaded，否则 systemd-run 拒绝重建同名单元。
   *  返回 {ok, errors}：stop/reset-failed 对「从未加载的单元」非零退出属正常，不计入 ok；
   *  硬失败只有删单元文件与 daemon-reload（run() 失败返回 null 不抛，成败须如实回传）。 */
  cleanTransient(unit) {
    const errors = [];
    const bad = unitNameViolation(unit);
    if (bad) return { ok: false, errors: [bad] }; // 非法名整链路拒绝（不进 systemctl、不拼删除路径）
    exec.runDetail('systemctl', ['--user', 'stop', unit + '.service'], { timeoutMs: 10000 });
    exec.runDetail('systemctl', ['--user', 'reset-failed', unit + '.service'], { timeoutMs: 10000 });
    let unlinkOk = true;
    try { const f = this.transientUnitFile(unit); if (f) fs.unlinkSync(f); } catch { unlinkOk = false; errors.push('unlink ' + unit + '.service'); }
    if (!exec.runDetail('systemctl', ['--user', 'daemon-reload'], { timeoutMs: 15000 }).ok) errors.push('daemon-reload');
    return { ok: unlinkOk && errors.length === 0, errors };
  },
  /** 以 transient 单元启动（独立 cgroup；每实例隔离）。
   *  @param {{unit:string, cmd:string[], env?:object, props?:string[], workingDir?:string, description?:string, timeoutMs?:number}} o
   *    props 为 systemd 属性（如 KillMode=process、MemoryMax=8G），平台层只拼装成 --property，不解释语义。 */
  startTransient(o) {
    const opts = o || {};
    const bad = unitNameViolation(opts.unit);
    if (bad) throw new Error('systemd-run 拒绝: ' + bad); // unit 名进 --unit= 前必须过白名单
    const args = ['--user', '--unit=' + opts.unit];
    if (opts.description) args.push('--description=' + opts.description);
    for (const p of (opts.props || [])) args.push('--property=' + p);
    for (const [k, v] of Object.entries(opts.env || {})) args.push('--setenv=' + k + '=' + v);
    if (opts.workingDir) args.push('--working-directory=' + opts.workingDir);
    args.push('--', ...(opts.cmd || []));
    // run() 失败会吞成 null；这里必须区分成败并抛错，否则 _systemdStart 的 catch 永不进入，
    // systemd-run 真实失败仍被当成启动成功（实例停在 STARTING，30s 后才转 BACKOFF）。
    const r = exec.runDetail('systemd-run', args, { timeoutMs: opts.timeoutMs || 20000 });
    if (!r.ok) throw new Error('systemd-run 失败: ' + (r.error || 'unknown') + (r.stderr ? ' | ' + String(r.stderr).trim() : ''));
    return true;
  },
  /** 运行期改限额（W3 动态化）：systemctl --user set-property 立即生效，无需重启单元。
   *  必带 --runtime：transient 单元本不落盘，不带它会把 drop-in 写进用户配置目录，陈旧下限永久黏住。
   *  值只来自 sandbox.unitProps 同源的 alloc（平台层翻译语义、不决定数额）。 */
  setLimits(unit, alloc) {
    if (unitNameViolation(unit)) return false; // 非法名绝不进 systemctl argv
    const a = alloc || {};
    const props = [];
    if (a.memoryMax) props.push('MemoryMax=' + a.memoryMax);
    if (a.memoryHigh) props.push('MemoryHigh=' + a.memoryHigh);
    if (a.cpuQuota) props.push('CPUQuota=' + a.cpuQuota);
    if (!props.length) return false;
    return exec.runDetail('systemctl', ['--user', 'set-property', '--runtime', unit].concat(props),
      { timeoutMs: 10000 }).ok;
  },
};

/* 不支持任何实例舱的平台（未知平台）：动词形态保持完整（X-3 方法集一致），拉起/停止显式抛错 */
function makeUnsupported(kind, label) {
  return {
    kind,
    supportsUnits: false,
    supportsTransient: false,
    daemonReload() { return false; },
    stopUnit() { throw new CapabilityError(label + '：不支持以用户单元方式管理被管实例'); },
    resetFailed() { return false; },
    isUnitActive(unit) { return unit ? false : true; },
    transientUnitFile() { return null; },
    // 无 transient 单元可清 = 成功；返回形态与 systemd 一致，调用方无需分支。
    cleanTransient() { return { ok: true, errors: [] }; },
    startTransient() { throw new CapabilityError(label + '：不支持拉起实例舱（portable 档未启用）'); },
    setLimits() { return false; },
  };
}

const NONE = makeUnsupported('none', '当前平台无服务管理器');

/** linux 上 systemd-run 的存在性：解析优先（resolveExecutable 即「可被 spawn」的准确语义，
 *  与 index.hasTool 同一口径），解析覆盖不到的 PATH 变体用一次有界实测兜底。
 *  结果模块期缓存：current() 在多个文件的模块顶层被调用，不在加载期反复 spawn。 */
let _systemdRun = null;
function hasSystemdRun() {
  if (_systemdRun === null) {
    _systemdRun = !!execPath.resolveExecutable('systemd-run') ||
      exec.runOut('systemd-run', ['--version'], { timeoutMs: 3000 }) !== null;
  }
  return _systemdRun;
}

function current() {
  if (PLATFORM === 'linux') return hasSystemdRun() ? systemd : portable;
  if (PLATFORM === 'darwin' || PLATFORM === 'win32') return portable;
  return NONE;
}

// _testProviders：X-3「provider 方法集完全一致」判据的静态对账缝——伪造 linux 且清空 PATH 时
// current() 只能落 portable，systemd/NONE 的键集在任意宿主都要拿得到，否则该不变量悄悄失去覆盖面。
module.exports = { current, CapabilityError, kind: () => current().kind, PLATFORM, UNIT_NAME_RE, unitNameViolation, _testProviders: { systemd, portable, NONE } };
