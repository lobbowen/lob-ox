'use strict';

const dshCli = require('../../platform/contract/dsh-cli');

const path = require('node:path');

const { isWindows } = require('../../shared/platform');
function root(rootDir, inst) { return path.join(rootDir, inst.id); }
function dataDir(rootDir, inst) { return path.join(root(rootDir, inst), 'data'); }
function installDir(rootDir, inst) { return path.join(root(rootDir, inst), 'install'); }

function nodeModulesDir(rootDir, inst) {
  const install = installDir(rootDir, inst);
  return isWindows ? path.join(install, 'node_modules') : path.join(install, 'lib', 'node_modules');
}
function dshEntry(rootDir, inst) {
  return path.join(nodeModulesDir(rootDir, inst), '@deepseek-ai', 'dsh', 'lib', 'bin.js');
}
function tmpDir(rootDir, inst) { return path.join(root(rootDir, inst), 'tmp'); }
function runPidFile(rootDir, inst) { return path.join(root(rootDir, inst), 'run.pid'); }
function launchCtx(rootDir, dshBin, inst) {
  const cmd = effectiveCommand(rootDir, dshBin, inst) || [];
  const anchors = [];
  if (cmd[1]) anchors.push(String(cmd[1]));
  if (inst.port) anchors.push('--port ' + inst.port);
  return { port: inst.port, pidFile: runPidFile(rootDir, inst), anchors };
}

function sandboxCommand(rootDir, inst) {
  const bin = dshEntry(rootDir, inst);
  return [process.execPath, bin, 'web', '--port', String(inst.port), '--host', '127.0.0.1', '--trusted-host', '127.0.0.1', '--no-open'];
}
function defaultCommand(dshBin, inst) {
  return [process.execPath, dshBin, 'web', '--port', String(inst.port), '--host', '127.0.0.1', '--trusted-host', '127.0.0.1', '--no-open'];
}
function effectiveCommand(rootDir, dshBin, inst) {
  if (inst.domain === 'sandbox' && (!inst.command || !inst.command.length)) return dshCli.withoutAutoOpen(sandboxCommand(rootDir, inst));
  if (inst.command && inst.command.length) return dshCli.withoutAutoOpen(inst.command);
  return dshCli.withoutAutoOpen(defaultCommand(dshBin, inst));
}

// R8-数据隔离：沙箱实例的「各自独立数据目录」必须覆盖 DSH 实际会写的**全部**位置。
// 原实现只重定向 HOME / XDG_CONFIG_HOME / XDG_DATA_HOME / TMPDIR，留下三个真实漏口：
//   1) Windows 上 Node 的 os.homedir() 读 USERPROFILE 而非 HOME，故 HOME 重定向在 Windows
//      上根本不生效——DSH 的配置/缓存仍写进真实用户目录；
//   2) APPDATA（Roaming）/ LOCALAPPDATA 是 Windows 上 npm/Electron 系工具的默认落点，
//      原实现完全没碰；
//   3) XDG_CACHE_HOME / XDG_STATE_HOME 未重定向，Linux 上缓存与状态漏到真实 HOME。
// 修法：把「用户级可写位置」一次配齐，并按平台补 Windows 专有变量。
// 注意这只做**数据隔离**（各自独立目录），不做安全隔离——容器化是后续独立议题。
function sandboxEnv(rootDir, inst) {
  const env = {};
  let workingDir = null;
  if (inst.domain === 'sandbox') {
    const data = dataDir(rootDir, inst);
    const install = installDir(rootDir, inst);
    const nodeBinDir = path.dirname(process.execPath);
    const paths = [nodeBinDir, path.join(install, 'bin'), process.env.PATH || ''].join(path.delimiter);
    // POSIX 侧：HOME 是 os.homedir() 的主判据；XDG 三件套覆盖配置/数据/缓存。
    env.HOME = data;
    env.USERPROFILE = data;              // Windows：os.homedir() 优先读它
    env.XDG_CONFIG_HOME = data;
    env.XDG_DATA_HOME = data;
    env.XDG_CACHE_HOME = path.join(data, 'cache');
    env.XDG_STATE_HOME = path.join(data, 'state');
    // Windows 侧：Roaming/Local 是 npm 与 Electron 系工具的默认落点。
    if (isWindows) {
      env.APPDATA = path.join(data, 'Roaming');
      env.LOCALAPPDATA = path.join(data, 'Local');
    }
    env.PATH = paths;
    env.NODE_PATH = nodeModulesDir(rootDir, inst);
    // npm 缓存与配置也钉死在实例内：否则 npm 会把下载缓存写到真实 HOME/.npm。
    env.npm_config_cache = path.join(data, 'npm-cache');
    env.npm_config_userconfig = path.join(data, '.npmrc');
    env.npm_config_globalconfig = path.join(data, '.npmrc');
    env.TMPDIR = tmpDir(rootDir, inst);
    if (isWindows) { env.TMP = env.TMPDIR; env.TEMP = env.TMPDIR; }
    workingDir = data;
  }
  return { env, workingDir };
}

module.exports = {
  root, dataDir, installDir, nodeModulesDir, dshEntry, tmpDir, runPidFile, launchCtx,
  effectiveCommand, sandboxEnv,
};
