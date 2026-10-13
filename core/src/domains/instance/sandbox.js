'use strict';

const dshCli = require('../../platform/contract/dsh-cli');

const path = require('node:path');

const { isWindows } = require('../../shared/platform');
const agentSandboxEnv = require('../agent/runtime/sandbox-env').sandboxEnv;
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
  if (inst.kind === 'sandbox' && (!inst.command || !inst.command.length)) return dshCli.withoutAutoOpen(sandboxCommand(rootDir, inst));
  if (inst.command && inst.command.length) return dshCli.withoutAutoOpen(inst.command);
  return dshCli.withoutAutoOpen(defaultCommand(dshBin, inst));
}

// R8-数据隔离：沙箱实例的「各自独立数据目录」必须覆盖 agent 实际会写的**全部**位置。
// 实现已收拢到 agent 域（domains/agent/runtime/sandbox-env.js）——env 重定向是
// agent 形态（sandbox）的运行时属性，与 instance 无关。此处只做目录装配后委托，
// 不再维护第二份 11 变量表（此前两份并存，改一处漏一处）。
// 注意这只做**数据隔离**（各自独立目录），不做安全隔离——容器化是后续独立议题。
function sandboxEnv(rootDir, inst) {
  if (!inst || inst.kind !== 'sandbox') return { env: {}, workingDir: null };
  return agentSandboxEnv({
    data: dataDir(rootDir, inst),
    install: installDir(rootDir, inst),
    nodeModules: nodeModulesDir(rootDir, inst),
    tmp: tmpDir(rootDir, inst),
  });
}

module.exports = {
  root, dataDir, installDir, nodeModulesDir, dshEntry, tmpDir, runPidFile, launchCtx,
  effectiveCommand, sandboxEnv,
};
