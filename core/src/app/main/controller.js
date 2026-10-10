'use strict';

const pidlook = require('../../platform/os/pidlookup');
const monitor = require('../../platform/service/monitor');
const BRAND = require('../../shared/brand');
const { startDeadlinePassed, childAlive: childAliveOf, adoptedAlive: adoptedAliveOf } = require('./decide');

const DEPS = new WeakMap();
function depsOf(host) {
  let d = DEPS.get(host);
  if (!d) {
    d = {
      config() { return host.config; },
      main() { return host.main; },
      state() { return host.state; },
      session() { return host.session; },
      exitIntended() { return host._exitIntended(); },
      events() { return host.events; },
      logger() { return host.logger; },
      ui() { return host.ui; },
      daemons() { return host.daemons; },
      intents() { return host.intents; },
      lan() { return host.lan; },
      control() { return host.control; },
      readTicking() { return host._ticking; }, writeTicking(v) { host._ticking = v; },
      stopping() { return host._stopping; },
      readLastMainPortRederive() { return host._lastMainPortRederive; },
      writeLastMainPortRederive(v) { host._lastMainPortRederive = v; },
      writeLastPortUp(v) { host._lastPortUp = v; },
      upgradeHold() { return host._upgradeHold; }, writeUpgradeHold(v) { host._upgradeHold = v; },
      upgradeHoldSince() { return host._upgradeHoldSince; }, writeUpgradeHoldSince(v) { host._upgradeHoldSince = v; },
      manualRestart() { return host.manualRestart; }, writeManualRestart(v) { host.manualRestart = v; },
      writeCrashHalted(v) { host._crashHalted = v; },
      sessionState() { return host._sessionState; },
      mChild() { return host._mChild(); },
      mAdoptPid() { return host._mAdoptPid(); },
      mObservedOnly() { return host._mObservedOnly(); },
      mSpawnBlockedUntil() { return host._mSpawnBlockedUntil(); },
      mStartDeadline() { return host._mStartDeadline(); },
      mSetStartDeadline(v) { return host._mSetStartDeadline(v); },
      mRestartAt() { return host._mRestartAt(); },
      mSetAdoptPid(v) { return host._mSetAdoptPid(v); },
      mSetObservedOnly(v) { return host._mSetObservedOnly(v); },
      mSetSpawnBlockedUntil(v) { return host._mSetSpawnBlockedUntil(v); },
      mSetMissingNotified(v) { return host._mSetMissingNotified(v); },
      mSetRestartAt(v) { return host._mSetRestartAt(v); },
    };
    DEPS.set(host, d);
  }
  return d;
}

module.exports = {
  methods: {
  async _dshConverge() {
    const d = depsOf(this);
    if (d.readTicking() || d.stopping()) return;
    if (d.exitIntended()) return;
    d.writeTicking(true);
    try {
      
      const targetView = await monitor.probe(d.config().targetHost, d.config().targetPort);
      const portUp = targetView.up;
      d.writeLastPortUp(portUp);
      const host = d.config().targetHost;
      const port = d.config().targetPort;
      
      
      const childAlive = childAliveOf(d.mChild());
      const adoptedAlive = adoptedAliveOf(d.mAdoptPid());
      const targetAlive = childAlive || adoptedAlive;

      if (!portUp && d.state().desired() !== 'stopped' && (childAlive || adoptedAlive || d.mObservedOnly())) {
        if (!d.readLastMainPortRederive() || Date.now() - d.readLastMainPortRederive() > 30000) {
          d.writeLastMainPortRederive(Date.now());
          const found = d.main().findManagedPort();
          if (found && found.port && found.port !== d.config().targetPort) {
            if (d.main().applyPort(found.port, found.pid)) {
              d.config().targetPort = found.port;
            }
          }
        }
      }

      if (d.state().desired() === 'stopped') {
        const managedAlive = childAlive || (adoptedAlive && !d.mObservedOnly());
        if (managedAlive) {
          d.main().stopProcess('desired_stopped');
        } else if (adoptedAlive && d.mObservedOnly()) {
          if (d.state().phase() !== 'OBSERVED') {
            d.state().setPhase('OBSERVED');
            d.state().write();
          }
        } else if (portUp) {
          d.main().adoptObserved();
        } else {
          if (d.mAdoptPid() !== null && !adoptedAlive) {
            d.events().append(BRAND.EVENT_HARNESS_EXITED, { code: null, signal: null, adopted: true, observed: true });
            d.mSetAdoptPid(null);
            d.mSetObservedOnly(false);
          }
          if (d.state().phase() !== 'STOPPED') d.state().setPhase('STOPPED');
        }
        d.state().write();
        return;
      }

      if (d.upgradeHold()) {
        if (targetAlive) {
          d.main().stopProcess('upgrade_hold');
        } else {
          if (d.state().phase() !== 'STOPPED') d.state().setPhase('STOPPED');
          const maxHold = (d.config().upgradeTimeoutMs || 600000) + 120000;
          if (d.upgradeHoldSince() && Date.now() - d.upgradeHoldSince() > maxHold) {
            d.events().append('upgrade_hold_timeout', {});
            d.ui().notify('升级流程异常', '升级 hold 超时已自动释放，请检查升级状态');
            d.writeUpgradeHold(false);
            d.writeUpgradeHoldSince(null);
          }
        }
        d.state().write();
        return;
      }

      
      
      const manual = d.manualRestart();
      if (manual) {
        d.writeManualRestart(false);
        const ph = d.state().phase();
        if (ph === 'RUNNING' || ph === 'STARTING') {
          d.intents().consume('restart'); d.intents().consume('start');
          d.main().beginRestart('manual', { manual: true, startupFailure: false });
        } else if (ph === 'STOPPED') {
          d.intents().consume('restart'); d.intents().consume('start');
        }
      }

      switch (d.state().phase()) {
        case 'STOPPED': {
          if (portUp) {
            d.main().adopt();
            d.mSetSpawnBlockedUntil(null);
            d.mSetMissingNotified(false);
          } else if (d.mSpawnBlockedUntil() && Date.now() < d.mSpawnBlockedUntil()) {
          } else if (await monitor.isPortListening(host, port, 1000)) {
            d.daemons().warnOccupied();
          } else if (d.session().shouldRun() && !d.exitIntended()) {
            d.intents().consume('start'); d.intents().consume('restart'); d.intents().consume('upgrade-resume');
            await d.main().startProcess();
          } else {
            if (d.state().phase() !== 'STOPPED') d.state().setPhase('STOPPED');
          }
          break;
        }
        case 'STARTING': {
          
          
          if (!targetAlive) {
            
            
            if (d.mStartDeadline() === null && (d.mRestartAt() === null || Date.now() >= d.mRestartAt())) {
              if (await monitor.isPortListening(host, port, 1000)) {
                d.daemons().warnOccupied();
              } else {
                await d.main().startProcess();
              }
            }
          } else if (d.mStartDeadline() !== null && startDeadlinePassed(d.mStartDeadline(), Date.now())) {
            d.main().enterRunning();
          }
          break;
        }
        case 'RUNNING': {
          const guarded = d.state().guardian();
          if (d.mAdoptPid() !== null && adoptedAlive === false) {
            d.events().append(BRAND.EVENT_HARNESS_EXITED, { code: null, signal: null, phase: d.state().phase(), adopted: true });
            d.mSetAdoptPid(null);
            if (guarded) d.main().beginRestart('adopted_exit', { startupFailure: false });
            else { d.writeCrashHalted(true); d.events().append('guardian_off_exit', { reason: 'adopted_exit 未监控，保持停止' }); d.state().setPhase('STOPPED'); }
          } else if (!childAlive && d.mChild()) {
            if (guarded) d.main().beginRestart('child_exit', { startupFailure: false });
            else { d.writeCrashHalted(true); d.events().append('guardian_off_exit', { reason: 'child_exit 未监控，保持停止' }); d.state().setPhase('STOPPED'); }
          }
          
          break;
        }
        case 'FAILED': {
          
          const startIntent = d.intents().consume('start');
          const restartIntent = d.intents().consume('restart');
          const wantsRetry = manual || startIntent !== undefined || restartIntent !== undefined;
          if (!wantsRetry) break;
          if (d.state().desired() === 'stopped') break;
          d.main().retryStartupFailure();
          d.mSetStartDeadline(null);
          d.mSetRestartAt(null);
          if (targetAlive) d.main().beginRestart('manual', { manual: true, startupFailure: false });
          else await d.main().startProcess();
          break;
        }
      }
      if (!d.daemons().enabled()) { try { d.lan().reconcile().catch(()=>{}); } catch {} }
      d.state().write();
    } catch (e) {
      d.logger().error('tick error: ' + ((e && e.stack) || e));
    } finally {
      d.writeTicking(false);
      if (d.sessionState() === 'starting') d.session().setState('running');
      try { d.control().syncDshView(); } catch (e) { d.logger().warn && d.logger().warn('sync: ' + (e && e.message)); }
    }
  }
  },
};
