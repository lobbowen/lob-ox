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

// 第一个 agent 产品的事实描述：DSH。包名 / 安装目录内的相对位置 / systemd 单元前缀 /
// 可执行名。收敛自装配层散落的字面量。
// 第二个 agent 产品真出现时再提炼通用形态——现在只做 DSH 一处收敛。
// 边界：只收「产品事实」。进程匹配模式（pgrepList('dsh')、proc.matchGuard）故意宽于
// 产品名——它还要匹配历史形态的进程，收敛会让宽松匹配依赖精确认知，故不收。
const DSH_PRODUCT = Object.freeze({
  pkg: '@deepseek-ai/dsh',
  pkgSegments: Object.freeze(['@deepseek-ai', 'dsh']),
  entryRel: Object.freeze(['lib', 'bin.js']),
  unitPrefix: 'dsh-web@',
  binName: 'dsh',
  protectedPkgs: Object.freeze(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']),
});

module.exports = { normalizeAgent, dataDirOf, installDirOf, tmpDirOf, nodeModulesDirOf, needsEnvIsolation, DSH_PRODUCT };