'use strict';

const fs = require('node:fs');
const pidlookup = require('./pidlookup');
const { judge: judgeIdentity, readPidFile } = require('./liveness');
const spawner = require('./spawn');
const procOS = require('./process');
const OUTCOME = require('../../shared/outcome');

const STOP_WAIT_CAP_MS = 3000;
const NAP_MS = 150;

function nap(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch {  }
}

// M5：readPidFile 与 platform/os/liveness.js 的同名函数行为逐字相同，
// 统一从 liveness 引入（单一判据源），本地不再保留副本。
function matchesAnchors(pid, anchors) {
  return judgeIdentity({ pid, anchors }).state === 'ours';
}

const portOf = (o) => { const p = Number(o && o.port); return Number.isInteger(p) && p > 0 ? p : 0; };
const pidFileOf = (o) => (o && o.pidFile) || null;
const anchorsOf = (o) => (Array.isArray(o && o.anchors) ? o.anchors : []);

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
   * 能力协商（与 router 域 `supports(cap)` 同一范式，下沉到平台层）。
   *
   * 判据来源：capability-profile.js 的 sandboxEnforcement —— 三平台均为 'supervise'
   * （= 产品自身监控，**无 cgroup 级强制**）。此前该字段全仓 0 处查询，
   *
   */
  supports(cap) {
    if (cap === 'treeKill') return true;              // detached spawn ⇒ 可整树终止
    if (cap === 'limits') return false;               // 无 OS 通道；配额已按「共享系统资源」决策移除
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
    if (!pidFile) return OUTCOME.UNKNOWN;
    if (fp === null || fp === undefined) return OUTCOME.fail('pid 文件不存在（无进程在跑）');
    if (!anchors.length) {
      return aliveOutcome(fp);
    }
    const st2 = aliveOutcome(fp);
    if (OUTCOME.isFail(st2)) return st2;
    if (OUTCOME.isUnknown(st2)) return st2;
    const cmd = pidlookup.readCmdline(fp);
    if (!cmd) return OUTCOME.UNKNOWN;           // 身份无从比对，不是"确定在跑"
    return matchesAnchors(fp, anchors) ? OUTCOME.OK : OUTCOME.UNKNOWN;
  },

  transientUnitFile() { return null; },

  async cleanTransient(unit, o) {
    const opts = o || {};
    const errors = [];
    if ((await this.stopUnit(unit, Object.assign({}, opts, { timeoutMs: 1500 }))) === false) errors.push('stop-unconfirmed');
    removePidFile(opts);
    return { ok: errors.length === 0, errors };
  },

};

module.exports = { portable, findOurs, matchesAnchors, _test: { readPidFile, matchesAnchors, findOurs } };
