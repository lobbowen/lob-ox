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
function unitProps(inst, alloc) {
  const props = [
    'KillMode=process',
    'MemoryMax=' + alloc.memoryMax,
  ];
  if (alloc.memoryHigh) props.push('MemoryHigh=' + alloc.memoryHigh);
  props.push(
    'CPUQuota=' + alloc.cpuQuota,
    'PrivateTmp=' + ((inst.sandbox && inst.sandbox.privateTmp) ? 'yes' : 'no'),
    'ProtectHome=' + ((inst.sandbox && inst.sandbox.protectHome) ? 'yes' : 'no'),
    'Restart=no',
  );
  return props;
}

function sandboxEnv(rootDir, inst) {
  const env = {};
  let workingDir = null;
  if (inst.domain === 'sandbox') {
    const data = dataDir(rootDir, inst);
    const install = installDir(rootDir, inst);
    const nodeBinDir = path.dirname(process.execPath);
    const paths = [nodeBinDir, path.join(install, 'bin'), process.env.PATH || ''].join(path.delimiter);
    env.HOME = data;
    env.XDG_CONFIG_HOME = data;
    env.XDG_DATA_HOME = data;
    env.PATH = paths;
    env.NODE_PATH = nodeModulesDir(rootDir, inst);
    
    env.TMPDIR = tmpDir(rootDir, inst);
    if (isWindows) { env.TMP = env.TMPDIR; env.TEMP = env.TMPDIR; }
    workingDir = data;
  }
  return { env, workingDir };
}

module.exports = {
  root, dataDir, installDir, nodeModulesDir, dshEntry, tmpDir, runPidFile, launchCtx,
  effectiveCommand, unitProps, sandboxEnv,
};
