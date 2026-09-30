'use strict';

// shell 域纯核心：域内依赖图汇点（零出度），汇集全部无 IO 判定/谓词/解析，与有副作用的 journal/restart/watchdog 分离；其它文件引用 core，core 无出边。
// 纪律：本文件不得出现模块引入 / fs. / spawn( / process.kill / setInterval / Date.now / Math.random，否则纯/IO 分离即破。

const DEFAULTS = {
  enabled: true,
  intervalMs: 20000,        // 检查周期
  graceMs: 90000,           // 壳缺失多久才动作（避让自更新/自重启空窗）
  updateGraceMs: 300000,    // 壳正处于更新/重启预期态时的宽限（5 分钟）
  maxRestarts: 5,           // 窗口内拉起次数上限
  windowMs: 1800000,        // 30 分钟窗口
  // identity.phase 的时效上限：超过则视为陈旧（壳已崩），不再当预期缺席，让看护按
  // 正常宽限期介入。取值需大于正常更新耗时（含下载+校验+重启）。
  phaseMaxAgeMs: 600000,    // 10 分钟
  procPattern: 'dsh-supervisor-gui',
};

/** 壳的无头模式全集：可执行文件名是壳、但语义上「桌面壳在运行」为假的入口清单。
 *  必须与壳侧 main.rs 里「在 Tauri 初始化之前 exit」的分支逐一对应——漏一项，看护就会把
 *  一次瞬时进程当成壳活着（alive > 0 直接短路，永不拉起真壳）。 */
const HEADLESS_FLAGS = Object.freeze([
  '--shell-update-plan', '--core-plan', '--node-plan', '--mirror-plan', '--env-plan',
  '--service-plan', '--platform-matrix', '--run-guard', '--watchdog',
]);
const HEADLESS_RE = new RegExp(HEADLESS_FLAGS.join('|'));

/** 判定进程是否为桌面壳主程序（而非本仓的无头自检进程）。 */
function isShellProcess(proc) {
  const c = String((proc && proc.cmdline) || '');
  // 无头自检入口会同时匹配进程名，必须排除，否则看护会把自检当成壳。
  if (HEADLESS_RE.test(c)) return false;
  return /dsh-supervisor-gui(\.exe)?/.test(c);
}

/** 纯决策（不碰进程/时钟/文件系统，便于穷举单测）。
 *  i: { alive, absentForMs, expectedAbsence, sessionAvailable, restartsInWindow, hasExe, config:{ graceMs, updateGraceMs, maxRestarts } }
 *  返回 { action:'alive'|'record'|'wait'|'skip'|'restart', reason, needMs? } */
function decide(i) {
  const c = i.config || {};
  if (i.alive > 0) return { action: 'alive', reason: '壳在运行' };
  if (i.absentForMs === null || i.absentForMs === undefined) {
    return { action: 'record', reason: '首次观察到壳缺失，开始计时' };
  }
  const needMs = i.expectedAbsence
    ? (c.updateGraceMs || DEFAULTS.updateGraceMs)
    : (c.graceMs || DEFAULTS.graceMs);
  if (i.absentForMs < needMs) {
    return { action: 'wait', reason: i.expectedAbsence ? '壳处于预期缺席（更新/重启）' : '未达宽限期', needMs };
  }
  if (!i.sessionAvailable) {
    return { action: 'skip', reason: '无图形会话（注销/纯终端），拉起 GUI 必失败' };
  }
  if ((i.restartsInWindow || 0) >= (c.maxRestarts || DEFAULTS.maxRestarts)) {
    return { action: 'skip', reason: '窗口内拉起次数已达上限，停止重试（防风暴）' };
  }
  if (!i.hasExe) {
    return { action: 'skip', reason: '无法定位壳可执行文件（identity.json 未记录 exe）' };
  }
  return { action: 'restart', reason: '壳缺失且已过宽限期', needMs };
}

/** 壳是否处于更新中相位（自更新/重启）：单一事实源。 */
function isUpdatePhase(phase) {
  const p = String(phase || '');
  return p === 'restarting' || p.indexOf('shell-update') === 0;
}

/** 解析进程命令行首段为可执行路径（处理 Windows 含空格的引号路径）。 */
function exeFromCmdline(cmdline) {
  const s = String(cmdline || '').trim();
  if (!s) return null;
  if (s.startsWith('"')) {
    const end = s.indexOf('"', 1);
    return end > 1 ? s.slice(1, end) : null;
  }
  return s.split(/\s+/)[0] || null;
}

/** 更新账本状态机纯内核：由（壳身份, 更新账本）两快照推导 { state, reason, ... }：
 *  idle 无进行中更新；pending 已安装待壳启动确认；confirmed 壳已成功运行新版本。
 *  无回退判定（壳更新强制且不可回退）。只描述事实不落盘（落盘由调用方 evaluate 按 state
 *  执行）；不修改入参：确认分支返回新账本对象（confirmed=true）。 */
function deriveState(id, journal) {
  const j = journal || {};
  if (!j.to) return { state: 'idle', reason: '无进行中的更新', journal: j, identity: id };

  const cur = id && id.version ? String(id.version) : null;

  // 壳已健康运行目标版本且 phase=ready -> 确认（账本翻转由 evaluate 落盘）
  if (cur && cur === j.to && id && id.phase === 'ready') {
    const next = j.confirmed === true ? j : Object.assign({}, j, { confirmed: true });
    return { state: 'confirmed', version: cur, reason: '壳已健康运行新版本', journal: next, identity: id };
  }

  // 其余：等待壳重启到目标版本并就绪。
  return {
    state: 'pending',
    target: j.to, current: cur,
    reason: cur === j.to ? '等待壳上报就绪' : '等待壳重启到新版本',
    journal: j, identity: id,
  };
}

module.exports = { DEFAULTS, isShellProcess, decide, isUpdatePhase, exeFromCmdline, deriveState, HEADLESS_FLAGS };
