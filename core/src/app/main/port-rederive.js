'use strict';

// app/main/port-rederive.js —— 原生 DSH 端口的运行时再推导（独立切面）：消费全局端口注册表（ports.register/release）并更正 config/dsh-main/relay 等跟随，与进程 spawn/停/杀生命周期正交。
// 由 app/assembly/facets.js 装到 host；成员名 _findManagedDshPort / _applyMainPort 不变——协作方接口表与 test/main-port-rederive-test.js 依赖。
// 依赖单向：本模块 -> platform（pidlookup/ports/config）；main/process.js -> 本模块。

const pidlook = require('../../platform/os/pidlookup');
const ports = require('../../platform/service/ports').shared;
const { extractPortFromCommand } = require('../../platform/service/config');

/** 原生 DSH 端口运行时再推导：DSH 端口用户可改（config 默认 3080 只是默认），真实端口以 cmdline --port 为准。
 *  配置端口无监听但受管 DSH 进程在跑时，找出其真实端口并更正注册，让系统跟随用户改动而非卡死旧配置。 */
function findManagedDshPort(config) {
  // 候选：配置 bin 精确匹配（config.command[1]）优先；兼容手动标准 DSH（isDshCmdline）
  const bins = [];
  const cmd = (config && config.command) || [];
  if (typeof cmd[1] === 'string' && cmd[1]) bins.push(cmd[1]);
  const candidates = [];
  const matches = pidlook.pgrepList('dsh');
  for (const m of matches) {
    const pid = m.pid;
    if (pid === process.pid) continue;
    const c = m.cmdline;
    if (c.indexOf('/instances/') >= 0) continue; // 排除沙箱实例 dsh-web@inst-*
    // 精确归属：cmdline 必须含本守卫配置的启动 bin；isDshCmdline 兜底仅用于
  // "config bin 缺失（手动标准安装）"且 cmdline 带 ' web' 子命令特征的场景，
  // 绝不把同机其它 dsh 实例误认作受管目标。
    const binMatch = bins.some((b) => b && c.indexOf(b) >= 0);
    const genericDsh = !bins.length && pidlook.isDshCmdline(pid) && /(^|\s)web(\s|$)/.test(c);
    const owned = binMatch || genericDsh;
    if (!owned) continue;
    // 复用 config.extractPortFromCommand（同一解析实现）。
    const port = extractPortFromCommand(c.split(' '));
    if (port) candidates.push({ pid, port, cmdline: c.slice(0, 120) });
  }
  // 多个候选：选正在监听其端口者（真在跑的实例），否则取第一个
  for (const c of candidates) { try { if (pidlook.findListeningPid(c.port) === c.pid) return c; } catch {} }
  return candidates[0] || null;
}

/** 应用原生 DSH 真实端口：更正 dsh-main 注册 / main 实例 / relay 目标 / healthUrl（五处跟随）。
 *  @param {object} host 组装上下文（config/logger/events/daemons 由 host 显式提供） */
function applyMainPort(host, newPort, pid) {
  const oldPort = host.config.targetPort;
  if (!Number.isInteger(newPort) || newPort <= 0 || newPort === oldPort) return false;
  // dsh-main 固定注册：register 新成功后再 release 旧（避免旧已释放、新被拒使注册表无 dsh-main
  // 而 config.targetPort 已改，注册表与配置分叉）。register 失败则不改配置、返回 false。
  try {
    ports.register('dsh-main', newPort);
  } catch (e) {
    host.logger.warn && host.logger.warn('register dsh-main ' + newPort + ' 失败，保留旧端口 ' + oldPort + ': ' + ((e && e.message) || e));
    return false;
  }
  // 释放必须带 ownerId：按端口号无条件释放可能删掉他人的记录（若 oldPort 期间被别的 owner
  // 重新登记）。owner 必须与 ports.register('dsh-main', p) 写入的完全一致，即 'system:' + role
  // （ports.js 的 register 固定写 'system:' + role），不是 'dsh-main'；写错会让释放变 no-op，
  // 旧端口残留（由 test/main-port-rederive-test.js 捕获）。
  try { if (oldPort !== newPort) ports.release(oldPort, 'system:dsh-main'); } catch {}
  host.config.targetPort = newPort;
  try { host.config.healthUrl = 'http://' + host.config.targetHost + ':' + newPort + '/'; } catch {}
  // main 不登记于沙箱 instances：端口唯一事实源 = config.targetPort，无 per-instance 记录
  // 可跟随；dshMain 端口由 dshMainView() 动态读 config.targetPort。
  host.events.append('main_port_adopted', { from: oldPort, to: newPort, pid });
  host.logger.warn && host.logger.warn('[main] DSH 真实端口 ' + newPort + '（原配置 ' + oldPort + '），已更正注册与 relay 目标');
  try { host.daemons.syncLanState(); } catch {}
  return true;
}

module.exports = {
  findManagedDshPort,
  applyMainPort,
  // 切面装配（app/assembly/facets.js）：成员名须与协作方接口表一致（既有测试依赖）。
  methods: {
    _findManagedDshPort() { return findManagedDshPort(this.config); },
    _applyMainPort(newPort, pid) { return applyMainPort(this, newPort, pid); },
  },
};
