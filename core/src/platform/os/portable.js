'use strict';

// portable LaunchProvider：三平台共用下限实现，无状态——实例身份 = 端口反查 + cmdline 锚点校验（与 monitor.probeInstance 同源锚）。
// run.pid 只作「STARTING 未监听窗口」的停止兜底：守卫重启后进程句柄必丢，盘上 pid 须配 cmdline 复核才防得住 PID 复用；
// 动词与 systemd Provider 同形（调用方不按 provider 分支）；isUnitActive 三态（查询未完成 != 不活跃）；setLimits 恒 false 是档位声明非失败。

const fs = require('node:fs');
const pidlookup = require('./pidlookup');
const spawner = require('./spawn');
const procOS = require('./process');

const STOP_WAIT_CAP_MS = 3000; // 同步等待上限：监督拍/心跳跑在事件循环线程上，绝不冻结到调用方 timeoutMs
const NAP_MS = 150;

/** 有界同步等待（仅 stopUnit 的停止复核轮询用）。
 *  Atomics.wait 是主线程合法阻塞原语：不引入 spawn 子进程（win32 无 sleep 命令），不忙转吃 CPU。 */
function nap(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* 不支持则退化为忙等，由时间预算兜底 */ }
}

/** run.pid 读取：无文件/内容非正整数一律 null（不参与判定，也不代表查询失败）。 */
function readPidFile(pidFile) {
  if (!pidFile) return null;
  try {
    const n = parseInt(String(fs.readFileSync(pidFile, 'utf8')).trim(), 10);
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch { return null; }
}

/** cmdline 锚点匹配：命中本实例启动命令的特征串（入口路径 / --port 参数）才算「我们的」进程。
 *  锚点缺失或 cmdline 读取失败一律 false——宁可判「不是我们的」也不误杀他人进程。 */
function matchesAnchors(pid, anchors) {
  if (!pid || !Array.isArray(anchors) || !anchors.length) return false;
  const cmd = pidlookup.readCmdline(pid);
  if (!cmd) return false;
  return anchors.some((a) => a && cmd.indexOf(String(a)) !== -1);
}

const portOf = (o) => { const p = Number(o && o.port); return Number.isInteger(p) && p > 0 ? p : 0; };
const pidFileOf = (o) => (o && o.pidFile) || null;
const anchorsOf = (o) => (Array.isArray(o && o.anchors) ? o.anchors : []);

/** 找「我们的」存活实例进程：{pid, ownGroup} 或 null。
 *  run.pid 命中的进程必由本 Provider detached 拉起（自成进程组）-> ownGroup=true 可组信号整树终止；
 *  仅端口锚点命中的监听进程来路不明（pidfile 丢失/手动实例）-> ownGroup=false 只发单进程信号：
 *  对外来 pid 做 kill(-pid) 会误杀无关进程组。 */
function findOurs(o) {
  const anchors = anchorsOf(o);
  const fp = readPidFile(pidFileOf(o));
  if (fp !== null && pidlookup.isAlive(fp) && matchesAnchors(fp, anchors)) return { pid: fp, ownGroup: true };
  const port = portOf(o);
  if (port) {
    const q = pidlookup.findListeningPid(port);
    if (q !== null && q !== fp && matchesAnchors(q, anchors)) return { pid: q, ownGroup: false };
  }
  return null;
}

function removePidFile(o) {
  const f = pidFileOf(o);
  if (f) { try { fs.unlinkSync(f); } catch { /* 已不存在=已清 */ } }
}

const portable = {
  kind: 'portable',
  supportsUnits: false,
  supportsTransient: true,

  // 无操作 = 成功（与 systemd 的动词返回形态一致，调用方无需按 provider 分支）。
  daemonReload() { return true; },
  resetFailed() { return true; },

  /** 拉起：spawn(detached)——POSIX 自成进程组（kill(-pid) 语义的前提）、win32 windowsHide +
   *  CREATE_NEW_PROCESS_GROUP（NO-CONSOLE-WINDOW 纪律收口在 platform/os/spawn.js）。
   *  调用方传来的 props（cgroup 语义）在此如实忽略：本档无内核强制可施加。
   *  @param {{cmd:string[], env?:object, workingDir?:string, pidFile?:string, port?:number, anchors?:string[]}} o */
  startTransient(o) {
    const opts = o || {};
    const cmd = opts.cmd || [];
    if (!cmd.length) throw new Error('portable 拉起拒绝：空命令');
    const child = spawner.detached(cmd[0], cmd.slice(1), {
      cwd: opts.workingDir || undefined,
      env: Object.assign({}, process.env, opts.env || {}),
    });
    // 无监听器的 'error' 事件会在 EventEmitter 约定下二次抛出打挂守卫：spawn 异步失败
    // （ENOENT/EPERM 于 pid 已分配后才到）在此吞掉，由监督拍按「端口 30s 未监听」判启动失败退避——与 systemd 档运行时失败同语义。
    child.on('error', () => {});
    if (!child.pid) {
      try { child.kill(); } catch { /* 未起成 */ }
      throw new Error('portable 拉起失败：spawn 未产生进程');
    }
    try { child.unref(); } catch { /* ignore */ }
    if (opts.pidFile) {
      // 兜底文件丢失不构成启动失败：端口锚点仍在，停止链退化为「只认端口」。
      try { fs.writeFileSync(opts.pidFile, String(child.pid)); } catch { /* ignore */ }
    }
    return true;
  },

  /** 停止（有界同步复核）：终止我们的进程树，确认「端口锚点与 run.pid 锚点双双消失」才 true。
   *  无可杀对象（含 run.pid 为陈旧/被 PID 复用）-> 清文件后如实 true（幂等）。 */
  stopUnit(unit, o) {
    const opts = o || {};
    const ours = findOurs(opts);
    if (!ours) { removePidFile(opts); return true; }
    try { procOS.killTree(ours.pid, 'SIGTERM', undefined, { ownGroup: ours.ownGroup }); }
    catch { /* 进程恰退出：交给下方复核 */ }
    const budget = Math.max(0, Math.min(typeof opts.timeoutMs === 'number' ? opts.timeoutMs : STOP_WAIT_CAP_MS, STOP_WAIT_CAP_MS));
    const t0 = Date.now();
    for (;;) {
      if (!findOurs(opts)) { removePidFile(opts); return true; }
      if (Date.now() - t0 >= budget) break;
      nap(NAP_MS);
    }
    // TERM 到期未退：portable 档无人代拆，自行 SIGKILL 升级后复核一次（cgroup 档由内核拆解，无此步）。
    try { procOS.killTree(ours.pid, 'SIGKILL', undefined, { ownGroup: ours.ownGroup }); } catch { /* ignore */ }
    nap(NAP_MS);
    if (!findOurs(opts)) { removePidFile(opts); return true; }
    return false; // 未确认停止：调用方保持原相位/保留数据（false != 成功，三态契约）
  },

  /** 活跃判定（三态）：port 与 pidFile 都缺 = 无从查询 -> null，删除保护路径不得把它当「已停止」。
   *  anchors 为空时降级为「端口有监听即活跃」（monitor.probeInstance 同口径，该调用方本就以此判在线）；
   *  杀进程（stopUnit）仍要求锚点命中 —— 判定可宽，动手必严。
   *  存活 pid 的 cmdline 读不到 = 分不清「他人复用」与「查询失败」-> null。 */
  isUnitActive(unit, o) {
    const opts = o || {};
    if (findOurs(opts)) return true;
    const port = portOf(opts);
    const pidFile = pidFileOf(opts);
    const anchors = anchorsOf(opts);
    if (!port && !pidFile) return null;
    if (!anchors.length) {
      // run.pid 是我方写入的归属凭证，存活即活跃；端口同理「有监听即活跃」。
      const fp = readPidFile(pidFile);
      if (fp !== null && pidlookup.isAlive(fp)) return true;
      if (port) {
        const q = pidlookup.findListeningPid(port);
        if (q !== null) return true;
        // pidlookup 把「查询失败」与「无监听」折成同一个 null（接口只回 pid）：
        // 只有持肯定证据才报 false —— pidfile 存在且进程已判死；否则报未知。
        if (fp !== null) return false;
        return null;
      }
      // 仅有 pidfile 锚点：判死=肯定不活跃；文件缺失/内容无效=无从查询。
      return fp !== null ? false : null;
    }
    const fp = readPidFile(pidFile);
    if (fp !== null && pidlookup.isAlive(fp) && !pidlookup.readCmdline(fp)) return null; // 存活且命令行不可读：未知（不当不活跃）
    return false;
  },

  // portable 无 systemd transient 单元文件；run.pid 的清理归 cleanTransient。
  transientUnitFile() { return null; },

  /** 清理同名残留：先停掉仍活着的旧进程（重启自愈路径：旧进程未监听端口时端口探测拦不住），再清 run.pid。 */
  cleanTransient(unit, o) {
    const opts = o || {};
    const errors = [];
    if (this.stopUnit(unit, Object.assign({}, opts, { timeoutMs: 1500 })) === false) errors.push('stop-unconfirmed');
    removePidFile(opts);
    return { ok: errors.length === 0, errors };
  },

  /** 返回值只表示「是否改动了内核强制」；governor 不因 false 走降级分支 —— 违规处置链本就平台无关。 */
  setLimits() { return false; },
};

// findOurs/matchesAnchors 是公开出口：全仓「我们拉起的外部进程」归属判定只此一处实现
//   （受管进程载体 carrier.js 与监督守卫共用；业务域一律经门面，不得自带 kill/-pgid 判定）。
module.exports = { portable, findOurs, matchesAnchors, _test: { readPidFile, matchesAnchors, findOurs } };
