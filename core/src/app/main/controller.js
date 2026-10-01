'use strict';

const pidlook = require('../../platform/os/pidlookup');
const monitor = require('../../platform/service/monitor');
const { startDeadlinePassed } = require('./decide');

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
      writeActWindow(v) { host._actWindow = v; },
      writeMainTickActs(v) { host._mainTickActs = v; },
      readLastMainPortRederive() { return host._lastMainPortRederive; },
      writeLastMainPortRederive(v) { host._lastMainPortRederive = v; },
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
      mBackoffUntil() { return host._mBackoffUntil(); },
      mSetLastProbeAt(v) { return host._mSetLastProbeAt(v); },
      mSetLastProbeOk(v) { return host._mSetLastProbeOk(v); },
      mSetLastProbeHttpOk(v) { return host._mSetLastProbeHttpOk(v); },
      mSetAdoptPid(v) { return host._mSetAdoptPid(v); },
      mSetObservedOnly(v) { return host._mSetObservedOnly(v); },
      mSetSpawnBlockedUntil(v) { return host._mSetSpawnBlockedUntil(v); },
      mSetMissingNotified(v) { return host._mSetMissingNotified(v); },
      mSetBackoffUntil(v) { return host._mSetBackoffUntil(v); },
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
    d.writeActWindow(true);
    d.writeMainTickActs([]);
    let t0 = null;
    try {
      const probeRes = await monitor.probe(d.config().targetHost, d.config().targetPort, {
        httpProbeEnabled: d.config().httpProbeEnabled !== false,
        healthUrl: d.config().healthUrl,
        httpTimeoutMs: d.config().probeTimeoutMs || 3000,
      });
      const portUp = probeRes.up;
      const healthOk = probeRes.httpOk;
      d.mSetLastProbeAt(new Date().toISOString());
      d.mSetLastProbeOk(portUp);
      d.mSetLastProbeHttpOk(healthOk);
      t0 = d.main().stateSnapshot();
      const host = d.config().targetHost;
      const port = d.config().targetPort;
      const childAlive = d.mChild() !== null && d.mChild().exitCode === null && d.mChild().signalCode === null;
      const adoptedAlive = d.mAdoptPid() !== null && pidlook.isAlive(d.mAdoptPid());
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
            d.events().append('dsh_exited', { code: null, signal: null, adopted: true, observed: true });
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

      if (d.manualRestart()) {
        d.writeManualRestart(false);
        if (d.state().phase() === 'RUNNING' || d.state().phase() === 'STARTING') {
          d.main().beginRestart('manual', { countCrash: false });
        } else if (d.state().phase() === 'RESTARTING' || d.state().phase() === 'BACKOFF') {
          d.mSetBackoffUntil(null);
          d.mSetRestartAt(Date.now());
          if (!targetAlive) await d.main().startProcess();
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
          if (portUp && healthOk) d.main().enterRunning();
          else if (d.mStartDeadline() === null) {
            d.mSetStartDeadline(Date.now() + d.config().startTimeoutMs);
          }
          else if (startDeadlinePassed(d.mStartDeadline(), Date.now())) d.main().beginRestart('start_timeout', { countCrash: true });
          break;
        }
        case 'RUNNING': {
          const guarded = d.state().guardian();
          if (d.mAdoptPid() !== null && adoptedAlive === false) {
            d.events().append('dsh_exited', { code: null, signal: null, phase: d.state().phase(), adopted: true });
            d.mSetAdoptPid(null);
            if (guarded) d.main().beginRestart('adopted_exit', { countCrash: true });
            else { d.writeCrashHalted(true); d.events().append('guardian_off_exit', { reason: 'adopted_exit 未守护，保持停止' }); d.state().setPhase('STOPPED'); }
          } else if (!childAlive && d.mChild()) {
            if (guarded) d.main().beginRestart('child_exit', { countCrash: true });
            else { d.writeCrashHalted(true); d.events().append('guardian_off_exit', { reason: 'child_exit 未守护，保持停止' }); d.state().setPhase('STOPPED'); }
          } else {
            const healthDecision = d.main().applyHealthCheck(healthOk);
            if (healthDecision && healthDecision.restart) {
              d.main().beginRestart(healthDecision.reason || 'http_unhealthy', { countCrash: healthDecision.countCrash === true });
            }
          }
          break;
        }
        case 'RESTARTING': {
          if (portUp && healthOk && (!d.mChild() && !adoptedAlive)) {
            d.main().adopt();
          } else if (!targetAlive && Date.now() >= d.mRestartAt()) {
            if (await monitor.isPortListening(host, port, 1000)) {
              d.daemons().warnOccupied();
            } else {
              await d.main().startProcess();
            }
          }
          break;
        }
        case 'BACKOFF': {
          if (portUp && healthOk && (!d.mChild() && !adoptedAlive)) {
            d.main().adopt();
          } else if (!targetAlive && Date.now() >= d.mBackoffUntil()) {
            if (await monitor.isPortListening(host, port, 1000)) {
              d.daemons().warnOccupied();
            } else {
              await d.main().startProcess();
            }
          }
          break;
        }
      }
      if (!d.daemons().enabled()) { try { d.lan().reconcile().catch(()=>{}); } catch {} }
      d.state().write();
    } catch (e) {
      d.logger().error('tick error: ' + ((e && e.stack) || e));
    } finally {
      d.writeTicking(false);
      d.writeActWindow(false);
      if (d.sessionState() === 'starting') d.session().setState('running');
      try { d.main().shadowTickNote(t0); } catch (e) { d.logger().warn && d.logger().warn('shadow note: ' + (e && e.message)); }
      try { d.control().syncDshView(); } catch (e) { d.logger().warn && d.logger().warn('sync: ' + (e && e.message)); }
    }
  }
  },
};
