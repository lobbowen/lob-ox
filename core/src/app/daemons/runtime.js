'use strict';

const scripts = require('./scripts');

const fs = require('node:fs');
const path = require('node:path');
const pidlook = require('../../platform/os/pidlookup');
const { writeAtomic } = require('../../platform/util/fs');
const { DaemonLifecycle } = require('./process');

const DEPS = new WeakMap();
function depsOf(host) {
  let d = DEPS.get(host);
  if (!d) {
    d = {
      configPath() { return host.configPath; },
      config() { return host.config; },
      ctl() { return host.ctl; },
      logger() { return host.logger; },
      events() { return host.events; },
      daemons() { return host.daemons; },
      instances() { return host.instances; },
      views() { return host.views; },
      tokenService() { return host.tokenService; },
      router() { return host.router; },
      dshMainView() { return host.dshMainView(); },
      daemonLifecycle(kind) { return host._daemonLifecycle(kind); },
      daemonEnsureResult(lc, writeOwnerLock) { return host._daemonEnsureResult(lc, writeOwnerLock); },
      disableRouterPersist() { return host._disableRouterPersist(); },
      readLc() { return host._lc; },
      writeLc(v) { host._lc = v; },
      readLastLanStateJson() { return host._lastLanStateJson; },
      writeLastLanStateJson(v) { host._lastLanStateJson = v; },
      readLastOccupiedWarn() { return host._lastOccupiedWarn; },
      writeLastOccupiedWarn(v) { host._lastOccupiedWarn = v; },
    };
    DEPS.set(host, d);
  }
  return d;
}

module.exports = {
  methods: {
    _daemonLifecycle(kind) {
      const d = depsOf(this);
      if (!d.configPath()) return null;
      let lc = d.readLc();
      if (!lc) { lc = {}; d.writeLc(lc); }
      if (lc[kind]) return lc[kind];
      const cfgPath = d.configPath();
      const isLan = kind === 'lan';
      const script = scripts.daemonScript(isLan ? 'lan' : 'router');
      if (!script) return null;
      const dir = path.dirname(d.config().stateFile);
      lc[kind] = new DaemonLifecycle({
        name: kind,
        script,
        args: ['-c', cfgPath],
        ctlPort: isLan ? d.ctl().lanPort() : d.ctl().routerPort(),
        cmdMark: isLan ? 'lan-daemon' : 'router-daemon',
        identityFile: path.join(dir, kind + '-daemon.identity.json'),
        spawnEnv: () => ({ DSH_SUPERVISOR_CONFIG: cfgPath }),
        logger: d.logger(),
        events: d.events(),
        // `this` 是宿主（本方法经 host._daemonLifecycle(kind) 调用）；箭头函数捕获它。
        // 此前写作 host._exitIntended()，而 host 只存在于 depsOf(host) 形参作用域 ⇒ 延迟回调求值时 ReferenceError。
        exitIntended: () => this._exitIntended(),
      });
      return lc[kind];
    },
    _daemonEnsureResult(lc, writeOwnerLock) {
      const rr = lc.ensureRunning();
      if (rr.mode === 'started' || rr.mode === 'adopted') {
        if (writeOwnerLock) writeOwnerLock();
        return rr.mode === 'started'
          ? { active: true, mode: 'daemon', spawned: rr.pid }
          : { active: true, mode: 'daemon' };
      }
      if (rr.mode === 'barrier') return { active: false, mode: 'barrier', reason: '生命周期窗口内' };
      if (rr.mode === 'reclaiming') return { active: false, mode: 'reclaiming', stale: rr.stale };
      if (rr.mode === 'stopping') return { active: false, mode: 'stopping' };
      if (rr.mode === 'failed') return { active: false, mode: 'error', error: rr.error || ('daemon 未启动: ' + lc.name) };
      return { active: false, mode: 'error', error: 'unexpected lifecycle mode: ' + rr.mode };
    },
    _syncLanState() {
      const d = depsOf(this);
      if (!d.daemons().enabled()) return;
      try {
        const dir = path.dirname(d.config().stateFile);
        const file = path.join(dir, 'lan-state.json');
        const inst = d.instances();
        const instances = [
          ...(inst ? inst.all() : []),
          ...(d.dshMainView ? [d.views().dshMain()] : []),
        ];
        const tokens = {};
        for (const i of instances) {
          try {
            const t = d.tokenService() && d.tokenService().get(i.id);
            tokens[i.id] = String(t || '');
          } catch {}
        }
                                // lan-state 哈希必须用稳定内容（无时间戳），否则每次监督 tick 都视为变化并重复 applyToken/换 cookie。
        const body = JSON.stringify({ instances: instances.map((i) => ({
          id: i.id, name: i.name, port: i.port,
          remoteMode: i.remoteMode === 'lan' || i.remoteMode === 'wan' ? i.remoteMode : 'off',
          remoteToken: i.remoteToken || '',
        })), tokens }, null, 1);
        if (body === d.readLastLanStateJson()) return;
        fs.mkdirSync(dir, { recursive: true });
        writeAtomic(file, body, { mode: 0o600 });
        d.writeLastLanStateJson(body);
      } catch (e) {
        d.logger() && d.logger().warn && d.logger().warn('_syncLanState: ' + (e && e.message));
      }
    },
    _ensureLanRuntime(desiredRunning) {
      const d = depsOf(this);
      try {
        const active = d.daemons().lanActive();
        const managed = d.daemons().lanManaged();
        if (desiredRunning !== false && active && managed) return { active: true, mode: 'daemon' };
        if (desiredRunning !== false && active && !managed) return { active: false, mode: 'external' };
        if (desiredRunning === false) {
          if (active && managed) {
            const lcC = d.daemonLifecycle('lan');
            const cc = (lcC && typeof lcC.classify === 'function') ? lcC.classify() : null;
            if (cc && cc.mode === 'external') {
              if (d.logger() && d.logger().warn) {
                d.logger().warn('[lan] 停止：ctl ' + d.ctl().lanPort() + ' 被外部进程占用（pid=' + cc.owner + '），拒绝停用以免误杀异主 daemon');
              }
              return { active: false, mode: 'external', refused: 'external' };
            }
            const pid = pidlook.findListeningPid(d.ctl().lanPort());
            if (pid) { try { process.kill(pid, 'SIGTERM'); } catch {} }
            d.daemons().clearLanLock();
            const lcS = d.daemonLifecycle('lan');
            if (lcS) { lcS._clearIdentity(); lcS._spawnWindowUntil = 0; }
            return { active: false, mode: 'daemon', stopping: true };
          }
          return { active: false, mode: 'none' };
        }
        const lc = d.daemonLifecycle('lan');
        if (!lc) return { active: false, mode: 'none', error: 'lan-daemon 脚本缺失' };
        return d.daemonEnsureResult(lc, () => d.daemons().writeLanLock());
      } catch (e) {
        return { active: false, mode: 'error', error: e.message };
      }
    },

    _ensureRouterRuntime(desiredRunning) {
      const d = depsOf(this);
      try {
        const daemonActive = d.daemons().routerActive();
        const managed = d.daemons().managed();
        if (desiredRunning !== false && daemonActive && managed) {
          d.disableRouterPersist();
          return { active: true, mode: 'daemon' };
        }
        if (desiredRunning !== false && daemonActive && !managed) {
          return { active: false, mode: 'embedded' };
        }
        if (desiredRunning === false) {
          if (daemonActive && managed) {
                        // managed 锁只是静态授权（锁内 pid 从不比对）：kill 前必须经 classify() 判动态归属，否则误杀外来同名 daemon。
            const lcS = d.daemonLifecycle('router');
            const c = (lcS && typeof lcS.classify === 'function') ? lcS.classify() : null;
            if (c && c.mode === 'external') {
              if (d.logger() && d.logger().warn) {
                d.logger().warn('[router] 停止：ctl ' + d.ctl().routerPort() + ' 被外部进程占用（pid=' + c.owner + '），拒绝停用以免误杀异主 daemon');
              }
              return { active: false, mode: 'embedded', refused: 'external' };
            }
            const pid = pidlook.findListeningPid(d.ctl().routerPort());
            if (pid) { try { process.kill(pid, 'SIGTERM'); } catch {} }
            d.daemons().clearRouterDaemonLock();
            if (lcS) { lcS._clearIdentity(); lcS._spawnWindowUntil = 0; }
            return { active: false, mode: 'daemon', stopping: true };
          }
          return { active: false, mode: 'embedded' };
        }
        if (!d.configPath()) {
          return { active: false, mode: 'embedded', reason: 'non-guard' };
        }
        const lc = d.daemonLifecycle('router');
        if (!lc) return { active: false, mode: 'embedded' };
        const res = d.daemonEnsureResult(lc, () => d.daemons().writeRouterDaemonLock());
        if (res && res.mode === 'daemon') d.disableRouterPersist();
        return res;
      } catch (e) {
        return { active: false, mode: 'error', error: e.message };
      }
    },

    _disableRouterPersist() {
      const d = depsOf(this);
      const router = d.router();
      if (router && typeof router.setPersistEnabled === 'function') {
        try { router.setPersistEnabled(false); } catch {}
      }
    },

    _warnOccupied() {
      const d = depsOf(this);
      const now = Date.now();
      if (now - d.readLastOccupiedWarn() > 60000) {
        d.writeLastOccupiedWarn(now);
        d.events().append('port_occupied_unhealthy', { host: d.config().targetHost, port: d.config().targetPort });
      }
    },
  },
};
