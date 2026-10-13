'use strict';

const path = require('node:path');
const { isWindows } = require('../../shared/platform');
const { NATIVE, SANDBOX, normalizeKind } = require('./kinds');

// 纯函数层：agent 记录的归一化与派生判定。无 IO、无 this，可单测。

// 归一化一条 agent 记录。缺省形态 = native（历史兼容）。
function normalizeAgent(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const kind = normalizeKind(raw.kind);
  const a = {
    id: String(raw.id || ''),
    product: String(raw.product || 'dsh'),
    kind,
    port: Number(raw.port) || 0,
    createdAt: Number(raw.createdAt) || 0,
  };
  if (raw.command && raw.command.length) a.command = raw.command.slice();
  if (raw.state) a.state = raw.state;
  return a.id ? a : null;
}

// 数据落点：sandbox 用每 agent 独立目录，native 用共享 dshHome。
// 这是 runtime 层的判据来源，UI 与清理逻辑都问它，不各自拼路径。
function dataDirOf(root, agent) {
  if (!agent) return null;
  if (agent.kind === SANDBOX) return path.join(root, agent.id, 'data');
  return require('node:path').join(root, 'dsh-home');
}

function installDirOf(root, agent) {
  if (!agent) return null;
  if (agent.kind === SANDBOX) return path.join(root, agent.id, 'install');
  return null;   // native 不单独装，用共享 prefix
}

// 是否需要在启动时做 env 全量重定向。
// 只 sandbox 需要——native 与壳同用户同环境，重定向反而破坏它。
function needsEnvIsolation(agent) { return !!agent && agent.kind === SANDBOX; }

// 临时目录：沙箱每 agent 一份。
function tmpDirOf(root, agent) {
  if (!agent || agent.kind !== SANDBOX) return null;
  return path.join(root, agent.id, 'tmp');
}

// node_modules 目录。**平台分支必须在这里**：npm 在 Windows 上装到
// <prefix>/node_modules，POSIX 上装到 <prefix>/lib/node_modules。
// 此前 agent/index.js 硬编码 'lib','node_modules' 而 instance/sandbox.js 有分支——
// 同一拼法两处不一致，沙箱形态一上线 Windows 的 NODE_PATH 立刻错。
function nodeModulesDirOf(root, agent) {
  const install = installDirOf(root, agent);
  if (!install) return null;
  return isWindows ? path.join(install, 'node_modules') : path.join(install, 'lib', 'node_modules');
}

module.exports = { normalizeAgent, dataDirOf, installDirOf, tmpDirOf, nodeModulesDirOf, needsEnvIsolation };