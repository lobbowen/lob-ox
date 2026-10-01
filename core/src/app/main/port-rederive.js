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
  try { if (oldPort !== newPort) ports.release(oldPort, 'system:dsh-main'); } catch {}
  host.config.targetPort = newPort;
  try { host.config.healthUrl = 'http://' + host.config.targetHost + ':' + newPort + '/'; } catch {}
  host.events.append('main_port_adopted', { from: oldPort, to: newPort, pid });
  host.logger.warn && host.logger.warn('[main] DSH 真实端口 ' + newPort + '（原配置 ' + oldPort + '），已更正注册与 relay 目标');
  try { host.daemons.syncLanState(); } catch {}
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
