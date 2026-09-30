'use strict';

// app/main/signals.js —— 进程终止信号与接管归属（_isManagedProcess/_signalChild/_killTree/_killSequence/_killAdopted）。
// 导出 { methods }，由 app/assembly/facets.js 装到 host；方法名与 { methods } 形态不可改（process-tree-kill-test 按符号名钉）。
// 事实经 depsOf(host) 的按 host 惰性缓存取得。
const pidlook = require('../../platform/os/pidlookup');
const platform = require('../../platform/os/index');
const { writeAtomic } = require('../../platform/util/fs');
const fs = require('node:fs');
const path = require('node:path');

/** SIGKILL 后的复核窗口（ms）：信号投递与内核回收需要时间，同一拍断言 isAlive 会把"正在死"误判成"杀不掉"。
 *  过窗口仍存活才判定「停止落空」并上报。 */
const ADOPT_KILL_VERIFY_MS = 2000;

const DEPS = new WeakMap();
function depsOf(host) {
  let d = DEPS.get(host);
  if (!d) {
    d = {
      config() { return host.config; },
      events() { return host.events; },
      logger() { return host.logger; },
      // 兄弟方法经 host 既有安装转发。
      mainOwnerFile() { return host._mainOwnerFile(); },
      readMainOwner() { return host._readMainOwner(); },
      signalChild(child, sig) { return host._signalChild(child, sig); },
      killTree(child, sig) { return host._killTree(child, sig); },
      readKillTimer() { return host._killTimer; },
      writeKillTimer(v) { host._killTimer = v; },
      readAdoptKillGen() { return host._adoptKillGen; },
      writeAdoptKillGen(v) { host._adoptKillGen = v; },
      readAdoptKillTimer() { return host._adoptKillTimer; },
      writeAdoptKillTimer(v) { host._adoptKillTimer = v; },
    };
    DEPS.set(host, d);
  }
  return d;
}

module.exports = {
  methods: {
  /** 主 DSH 归属凭据文件：与 lan/router daemon 的 *-daemon.identity.json 同范式、同址（stateFile 目录）。
   *  接管只凭 cmdline 子串相似会让两个守卫认领同一个 DSH、互 stop/kill 对方刚接管的进程，故落凭据声明归属。 */
  _mainOwnerFile() {
    const d = depsOf(this);
    try { return path.join(path.dirname(d.config().stateFile), 'dsh-main.owner.json'); } catch { return null; }
  },

  /** 读归属凭据；缺失/损坏一律 null（绝不因读失败而接管或否决，判定回落 cmdline）。 */
  _readMainOwner() {
    const d = depsOf(this);
    try {
      const p = d.mainOwnerFile();
      if (!p) return null;
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      return (j && typeof j === 'object' && j.dshPid) ? j : null;
    } catch { return null; }
  },

  /** 落归属凭据：声明 pid=<dshPid> 的主 DSH 由本守卫（guardPid）负责；spawn 与 adopt 两条取得所有权的路线都要写。
   *  落盘走 writeAtomic 单源（tmp 名含 pid+时间戳，多实例并发不互相覆盖）+ 0600，与 daemon 身份文件同法。 */
  _writeMainOwner(dshPid, port) {
    const d = depsOf(this);
    try {
      const p = d.mainOwnerFile();
      if (!p || !dshPid) return;
      writeAtomic(p, JSON.stringify({
        guardPid: process.pid, dshPid, port: port || null, startedAt: Date.now(),
      }), { mode: 0o600 });
    } catch (e) {
      d.logger() && d.logger().warn && d.logger().warn('writeMainOwner: ' + ((e && e.message) || e));
    }
  },

  /** 校验 pid 是否属本守卫：cmdline 含配置启动 bin 或符合 DSH 特征（兼容外部手动起的标准 DSH）；
   *  精确匹配避免"路径碰巧含 dsh 误接管"与"安装路径不含 dsh 漏接管"。
   *  归属凭据只做否决（别的存活守卫拥有此 pid 时不接管），不单独放行：陈旧凭据的 pid 可能已被内核复用，单独放行会误接管无关进程。 */
  _isManagedProcess(pid) {
    const d = depsOf(this);
    const own = d.readMainOwner();
    if (own && own.dshPid === pid && own.guardPid && own.guardPid !== process.pid
        && pidlook.isAlive && pidlook.isAlive(own.guardPid)) {
      d.logger() && d.logger().warn && d.logger().warn(
        'refuse adopt pid=' + pid + '：归属凭据指向另一存活守卫 pid=' + own.guardPid + '（不双管家互杀）');
      return false;
    }
    const cmd = pidlook.readCmdline(pid);
    if (!cmd) return false;
    const bin = d.config().command && d.config().command[1];
    if (typeof bin === 'string' && bin && cmd.includes(bin)) return true;
    // 兜底只给「手动标准安装的 DSH」：其真实形态是 dsh web --port N，故 web 子命令词
    //   必须与 dsh 特征同时成立。isDshCmdline 单独放行等于「命令行里出现过 dsh 三个
    //   字母」——从含 dsh 的检出目录或安装路径跑的任意脚本都会被接管，接管后守卫
    //   对它发 SIGTERM，即本函数上方注释要避开的「路径碰巧含 dsh 误接管」。
    //   与 port-rederive.js 的 genericDsh 同一条闸：跨进程归属判定只此一处标准。
    return /(^|\s)web(\s|$)/.test(cmd) && pidlook.isDshCmdline(pid);
  },

  /** 向进程组发信号（detached spawn 的子进程是组长）；组信号失败退回单进程。平台层封装：
   *  POSIX 组信号；Windows 无组语义则单进程信号，树语义由 killTree 提供。 */
  _signalChild(child, sig) {
    platform.processControl.signalProcess(child.pid, sig);
  },

  /** 整树终止：必须单独存在。平台层 killTree（Windows taskkill /PID <pid> /T /F，POSIX 进程组信号）
   *  与 signalProcess 不同，后者在 Windows 只杀单进程——停止 DSH 会遗留子进程成孤儿、继续占端口与文件锁，守卫重启 adopt 即被楔死。
   *  child 恒为本守卫 detached 拉起的组长，故显式 ownGroup:true 走组信号（POSIX 退化为组信号，幂等无害）。 */
  _killTree(child, sig) {
    const d = depsOf(this);
    const pc = platform.processControl;
    if (pc && typeof pc.killTree === 'function') {
      pc.killTree(child.pid, sig || 'SIGKILL', () => {}, { ownGroup: true });
      return;
    }
    // 兜底：平台层未提供时退回单进程信号（不因能力缺失而完全不杀）
    d.signalChild(child, sig || 'SIGKILL');
  },

  _killSequence(child) {
    const d = depsOf(this);
    d.events().append('sigterm_sent', { pid: child.pid });
    // 优雅期先发 SIGTERM（Windows 上仍单进程，给目标自行收尾的机会），超时后的 SIGKILL 才升级为整树（孤儿才是真问题）。
    d.signalChild(child, 'SIGTERM');
    d.writeKillTimer(setTimeout(() => {
      d.writeKillTimer(null);
      if (child.exitCode === null && child.signalCode === null) {
        d.killTree(child, 'SIGKILL');
        d.events().append('sigkill_sent', { pid: child.pid, tree: platform.PLATFORM === 'win32' });
      }
    }, d.config().stopGraceMs));
  },

  /** 杀无句柄的接管实例（仅知 pid）。失败不再静默：SIGKILL 后另给复核窗口，仍存活才判「停止落空」发 stop_failed + warn。
   *  代际 gen：本文件只有一个 _adoptKillTimer 槽位，后一次 kill 会覆盖前一次句柄；故每次自增 _adoptKillGen，
   *  定时器只在「本代仍是当前代」时置空槽位，防旧 timer 清掉新句柄。
   *  代际只保护共享槽位：每个 timer 仍按自己的 pid 完成升级与复核，不因换代跳过（否则前一个 pid 的 SIGKILL 升级被吞）。 */
  _killAdopted(pid) {
    const d = depsOf(this);
    const gen = (d.readAdoptKillGen() || 0) + 1;
    d.writeAdoptKillGen(gen);
    const releaseSlot = () => { if (gen === d.readAdoptKillGen()) d.writeAdoptKillTimer(null); };
    d.events().append('sigterm_sent', { pid, adopted: true });
    try {
      process.kill(pid, 'SIGTERM');
    } catch {}
    d.writeAdoptKillTimer(setTimeout(() => {
      releaseSlot();
      if (pidlook.isAlive(pid)) {
        // 接管实例可能有子进程：Windows 升级为整树（taskkill /T /F），否则留孤儿子进程占端口。
        // POSIX 外来 pid 不发组信号（可能恰为无关进程组组长，kill(-pid) 误杀整组），故不传 ownGroup -> 平台层退化单进程 SIGKILL。
        const pc = platform.processControl;
        if (pc && typeof pc.killTree === 'function') {
          pc.killTree(pid, 'SIGKILL', () => {});
        } else {
          try { process.kill(pid, 'SIGKILL'); } catch {}
        }
        d.events().append('sigkill_sent', { pid, adopted: true, tree: platform.PLATFORM === 'win32' });
        // 复核：SIGKILL 生效是异步的，须另起一拍才能断言成败。
        const verify = setTimeout(() => {
          releaseSlot();
          if (!pidlook.isAlive(pid)) return;
          d.events().append('stop_failed', { pid, adopted: true, reason: 'SIGKILL 后仍存活' });
          if (d.logger() && d.logger().warn) {
            d.logger().warn('[main] 接管实例停止落空：pid ' + pid + ' 在 SIGKILL 后仍存活');
          }
        }, ADOPT_KILL_VERIFY_MS);
        // unref：复核窗口纯观测，不应拖住进程退出（shutdown 亦会清 _adoptKillTimer）。
        if (verify && typeof verify.unref === 'function') verify.unref();
        d.writeAdoptKillTimer(verify);
      }
    }, d.config().stopGraceMs));
  }
  },
};
