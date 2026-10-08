'use strict';

const fs = require('node:fs');
const pidlookup = require('./pidlookup');
const spawner = require('./spawn');
const procOS = require('./process');
const OUTCOME = require('../../shared/outcome');

const STOP_WAIT_CAP_MS = 3000;
const NAP_MS = 150;

function nap(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch {  }
}

function readPidFile(pidFile) {
  if (!pidFile) return null;
  try {
    const n = parseInt(String(fs.readFileSync(pidFile, 'utf8')).trim(), 10);
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch { return null; }
}

function matchesAnchors(pid, anchors) {
  if (!pid || !Array.isArray(anchors) || !anchors.length) return false;
  const cmd = pidlookup.readCmdline(pid);
  if (!cmd) return false;
  return anchors.some((a) => a && cmd.indexOf(String(a)) !== -1);
}

const portOf = (o) => { const p = Number(o && o.port); return Number.isInteger(p) && p > 0 ? p : 0; };
const pidFileOf = (o) => (o && o.pidFile) || null;
const anchorsOf = (o) => (Array.isArray(o && o.anchors) ? o.anchors : []);

// run.pid 命中即本方 detached 拉起 → ownGroup=true 可整树；仅端口锚点命中的监听者来路不明 → 只发单进程信号。
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
  if (f) { try { fs.unlinkSync(f); } catch {  } }
}


// 取 pid 存活的 Outcome 三态。
// 兼容：测试桩可能只提供 isAlive/probeAlive 而不提供 outcomeAlive ⇒ 回退推导，不得抛错。
function aliveOutcome(pid) {
  if (typeof pidlookup.outcomeAlive === 'function') return pidlookup.outcomeAlive(pid);
  if (typeof pidlookup.probeAlive === 'function') {
    const st = pidlookup.probeAlive(pid);
    if (st === 'alive') return OUTCOME.OK;
    if (st === 'dead') return OUTCOME.fail('pid ' + pid + ' 已退出');
    return OUTCOME.UNKNOWN;
  }
  const a = !!pidlookup.isAlive(pid);
  return a ? OUTCOME.OK : OUTCOME.fail('pid ' + pid + ' 已退出');
}

const portable = {
  kind: 'portable',
  supportsUnits: false,
  supportsTransient: true,

  /**
   * 能力协商（根因 B 修法；与 router 域 `supports(cap)` 同一范式，下沉到平台层）。
   *
   * 判据来源：capability-profile.js 的 sandboxEnforcement —— 三平台均为 'supervise'
   * （= 产品自身监控，**无 cgroup 级强制**）。此前该字段全仓 0 处查询，
   * 于是 governor 在"限额根本无法生效"的前提下仍判违规并重启 ⇒ 永动机（P0）。
   *
   * 调用方（governor）必须先问后处置：不支持限额 ⇒ 只观测，绝不重启。
   */
  supports(cap) {
    if (cap === 'treeKill') return true;              // detached spawn ⇒ 可整树终止
    if (cap === 'limits') return false;               // 无 OS 通道 ⇒ 不强制内存/CPU
    if (cap === 'unit') return false;                 // 无 systemd / launchd / 任务计划
    return false;
  },

  daemonReload() { return true; },
  resetFailed() { return true; },

  startTransient(o) {
    const opts = o || {};
    const cmd = opts.cmd || [];
    if (!cmd.length) throw new Error('portable 拉起拒绝：空命令');
    const child = spawner.detached(cmd[0], cmd.slice(1), {
      cwd: opts.workingDir || undefined,
      env: Object.assign({}, process.env, opts.env || {}),
    });
    // 无监听器的 'error' 会二次抛出打挂守卫：spawn 异步失败在此吞掉，由监督拍按「端口 30s 未监听」判失败退避。
    child.on('error', () => {});
    if (!child.pid) {
      try { child.kill(); } catch {  }
      throw new Error('portable 拉起失败：spawn 未产生进程');
    }
    try { child.unref(); } catch {  }
    if (opts.pidFile) {
      try { fs.writeFileSync(opts.pidFile, String(child.pid)); } catch {  }
    }
    return true;
  },

  // 审计 P0-I5：原实现在 Windows 上用 Atomics.wait（nap）**同步冻结事件循环**做轮询、且 SIGKILL 兜底分支
  // 调用的 taskkill 完全异步不 await ⇒ 停止"无法确认"（常返回 false），进而实例仍被标 RUNNING、
  // upgrade.js 在上个进程仍占端口时继续重装 ⇒ 与端口预检撞车回滚（正是 upgrade.js 想防的故障）。
  // 修复：改为 async，用 real-timer 轮询（不阻塞事件循环），并等待 taskkill 真正结束（有界 10s，与 process.js killTree 同），
  // 给足停止窗口再判定；仍超时再报 false（如实，不再假成功）。timeoutMs 仍被 STOP_WAIT_CAP_MS 截断（与调用方意图无关）。
  async stopUnit(unit, o) {
    const opts = o || {};
    const ours = findOurs(opts);
    if (!ours) { removePidFile(opts); return true; }
    try { procOS.killTree(ours.pid, 'SIGTERM', undefined, { ownGroup: ours.ownGroup }); }
    catch {  }
    const budget = Math.max(0, Math.min(typeof opts.timeoutMs === 'number' ? opts.timeoutMs : STOP_WAIT_CAP_MS, STOP_WAIT_CAP_MS));
    const t0 = Date.now();
    while (Date.now() - t0 < budget) {
      if (!findOurs(opts)) { removePidFile(opts); return true; }
      await new Promise((r) => setTimeout(r, NAP_MS));
    }
    // SIGKILL 兜底：Windows taskkill /T /F 遍历子树，需 await（有界 10s，process.js killTree 已保证 fail-closed 不 reject）。
    try {
      await new Promise((resolve) => {
        let done = false;
        procOS.killTree(ours.pid, 'SIGKILL', () => { done = true; resolve(true); }, { ownGroup: ours.ownGroup });
        setTimeout(() => { if (!done) resolve(false); }, 10000);
      });
    } catch {  }
    if (!findOurs(opts)) { removePidFile(opts); return true; }
    return false;
  },

  daemonReload() { return true; },
  resetFailed() { return true; },

  startTransient(o) {
    const opts = o || {};
    const cmd = opts.cmd || [];
    if (!cmd.length) throw new Error('portable 拉起拒绝：空命令');
    const child = spawner.detached(cmd[0], cmd.slice(1), {
      cwd: opts.workingDir || undefined,
      env: Object.assign({}, process.env, opts.env || {}),
    });
    // 无监听器的 'error' 会二次抛出打挂守卫：spawn 异步失败在此吞掉，由监督拍按「端口 30s 未监听」判失败退避。
    child.on('error', () => {});
    if (!child.pid) {
      try { child.kill(); } catch {  }
      throw new Error('portable 拉起失败：spawn 未产生进程');
    }
    try { child.unref(); } catch {  }
    if (opts.pidFile) {
      try { fs.writeFileSync(opts.pidFile, String(child.pid)); } catch {  }
    }
    return true;
  },

  stopUnit(unit, o) {
    const opts = o || {};
    const ours = findOurs(opts);
    if (!ours) { removePidFile(opts); return true; }
    try { procOS.killTree(ours.pid, 'SIGTERM', undefined, { ownGroup: ours.ownGroup }); }
    catch {  }
    const budget = Math.max(0, Math.min(typeof opts.timeoutMs === 'number' ? opts.timeoutMs : STOP_WAIT_CAP_MS, STOP_WAIT_CAP_MS));
    const t0 = Date.now();
    for (;;) {
      if (!findOurs(opts)) { removePidFile(opts); return true; }
      if (Date.now() - t0 >= budget) break;
      nap(NAP_MS);
    }
    try { procOS.killTree(ours.pid, 'SIGKILL', undefined, { ownGroup: ours.ownGroup }); } catch {  }
    nap(NAP_MS);
    if (!findOurs(opts)) { removePidFile(opts); return true; }
    return false;
  },

  /**
   * 单元是否活跃 —— 返回 Outcome 三态（根因 A 修法）。
   *
   * 此前返回 null 表示"未知"，而调用方 instance/ops.js:67 用 `active !== false` 判，
   * 于是 null（未知）被当成"仍活跃" ⇒ removeInstance 把未知报成删除成功（P0）。
   *
   * 关键修正：**无 anchors 时不得把"有人在监听"当成"我们的实例在跑"**。
   * 端口是共享事实、不是身份（与 monitor.js#matchesAnchors 同一条判据）；
   * 缺锚点即无从验证身份 ⇒ 如实返回 unknown，由调用方决定（升级校验须失败并回滚）。
   *
   * 兼容：既有调用方若直接判真假，Outcome 对象恒为真值，行为同"true"，不会静默反转；
   *      但显式判据（isOk/isFail/isUnknown）才能区分三态——见 shared/outcome.js。
   */
  isUnitActive(unit, o) {
    const opts = o || {};
    if (findOurs(opts)) return OUTCOME.OK;
    const port = portOf(opts);
    const pidFile = pidFileOf(opts);
    const anchors = anchorsOf(opts);
    if (!port && !pidFile) return OUTCOME.UNKNOWN;
    const fp = readPidFile(pidFile);
    // 区分两种"没有 pid"：
    //   * 调用方**根本没给 pidFile**（无查询入口）⇒ 判不出 ⇒ unknown
    //   * **给了 pidFile 但文件不存在**（portable 写于 startTransient、删除于 stopUnit）
    //     ⇒ 进程槽位为空 ⇒ **确定的不活跃**（肯定证据，删除/停机路径依赖它）
    if (!pidFile) return OUTCOME.UNKNOWN;
    if (fp === null || fp === undefined) return OUTCOME.fail('pid 文件不存在（无进程在跑）');
    if (!anchors.length) {
      // 无身份锚点：只能判 pid 文件里的 pid 是否还活着；不得用"端口有人监听"顶替身份。
      return aliveOutcome(fp);
    }
    // 有锚点：pid 存活 + cmdline 能读到并对上锚点，才是"我们的实例在跑"。
    const st2 = aliveOutcome(fp);
    if (OUTCOME.isFail(st2)) return st2;
    if (OUTCOME.isUnknown(st2)) return st2;
    const cmd = pidlookup.readCmdline(fp);
    if (!cmd) return OUTCOME.UNKNOWN;           // 身份无从比对，不是"确定在跑"
    return matchesAnchors(fp, anchors) ? OUTCOME.OK : OUTCOME.UNKNOWN;
  },

  transientUnitFile() { return null; },

  // 审计 P0-I5：随 stopUnit 改为 async，cleanTransient 也须 await（不得再用 === false 同步判）。
  async cleanTransient(unit, o) {
    const opts = o || {};
    const errors = [];
    if ((await this.stopUnit(unit, Object.assign({}, opts, { timeoutMs: 1500 }))) === false) errors.push('stop-unconfirmed');
    removePidFile(opts);
    return { ok: errors.length === 0, errors };
  },

  setLimits() { return false; },
};

module.exports = { portable, findOurs, matchesAnchors, _test: { readPidFile, matchesAnchors, findOurs } };
