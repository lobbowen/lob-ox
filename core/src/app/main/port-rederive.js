'use strict';

const pidlook = require('../../platform/os/pidlookup');
const ports = require('../../platform/service/ports').shared;
const { extractPortFromCommand } = require('../../platform/service/config');

function findManagedDshPort(config) {
  const bins = [];
  const cmd = (config && config.command) || [];
  if (typeof cmd[1] === 'string' && cmd[1]) bins.push(cmd[1]);
  const candidates = [];
  const matches = pidlook.pgrepList('dsh');
  for (const m of matches) {
    const pid = m.pid;
    if (pid === process.pid) continue;
    const c = m.cmdline;
    if (c.indexOf('/instances/') >= 0) continue;
    const binMatch = bins.some((b) => b && c.indexOf(b) >= 0);
    const genericDsh = !bins.length && pidlook.isDshCmdline(pid) && /(^|\s)web(\s|$)/.test(c);
    const owned = binMatch || genericDsh;
    if (!owned) continue;
    const port = extractPortFromCommand(c.split(' '));
    if (port) candidates.push({ pid, port, cmdline: c.slice(0, 120) });
  }
  for (const c of candidates) { try { if (pidlook.findListeningPid(c.port) === c.pid) return c; } catch {} }
  return candidates[0] || null;
}

function applyMainPort(host, newPort, pid) {
  const oldPort = host.config.targetPort;
  if (!Number.isInteger(newPort) || newPort <= 0 || newPort === oldPort) return false;
  
  
  
  try {
    ports.register('dsh-main', newPort);
  } catch (e) {
    host.logger.warn && host.logger.warn('register dsh-main ' + newPort + ' 失败，保留旧端口 ' + oldPort + ': ' + ((e && e.message) || e));
    return false;
  }
  // 旧端口释放失败必须被看见：此前这个 if/else 两个分支都把 released 置为 true，
  // 变量本身又从不读取，等于「释放失败」与「释放成功」两种情况被完全抹平，
  // 而旧端口的注册会一直留在账本里形成泄漏。这里如实记录并在返回前告警，
  // 同时把释放失败纳入事件的 payload，让「端口已改但旧登记仍在」成为可观测事实。
  let released = false;
  let releaseError = null;
  try {
    if (oldPort !== newPort) {
      released = !!ports.release(oldPort, 'system:dsh-main');
      if (!released) releaseError = 'release 返回 false';
    } else {
      released = true;
    }
  } catch (e) {
    releaseError = (e && e.message) || String(e);
    
    try { ports.release(newPort, 'system:dsh-main'); } catch {}
    host.logger.warn && host.logger.warn('release 旧端口 ' + oldPort + ' 失败，已回滚新端口 ' + newPort + ' 登记: ' + ((e && e.message) || e));
    return false;
  }
  if (!released) {
    host.logger.warn && host.logger.warn('[main] 已改用端口 ' + newPort + '，但旧端口 ' + oldPort
      + ' 的登记未能释放（' + (releaseError || '未知原因') + '），账本可能残留一个幽灵占用');
  }
  host.config.targetPort = newPort;
  host.config.healthUrl = 'http://' + host.config.targetHost + ':' + newPort + '/';
  
  let lanSync = 'failed';
  try {
    if (host.daemons && typeof host.daemons.syncLanState === 'function') host.daemons.syncLanState();
    lanSync = 'ok';
  } catch (e) {
    host.logger.warn && host.logger.warn('[main] 端口已改用 ' + newPort + '，但 relay/LAN 目标同步失败: ' + ((e && e.message) || e));
  }
  host.events.append('main_port_adopted', { from: oldPort, to: newPort, pid, lanSync, oldPortReleased: released, releaseError: releaseError || null });
  host.logger.warn && host.logger.warn('[main] DSH 真实端口 ' + newPort + '（原配置 ' + oldPort + '）'
    + (lanSync === 'ok' ? '，已更正注册与 relay 目标' : '，注册已改但 relay/LAN 同步未确认'));
  return true;
}

module.exports = {
  findManagedDshPort,
  applyMainPort,
  methods: {
    _findManagedDshPort() { return findManagedDshPort(this.config); },
    _applyMainPort(newPort, pid) { return applyMainPort(this, newPort, pid); },
  },
};
