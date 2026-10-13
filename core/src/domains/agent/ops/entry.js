'use strict';

// agent 入口定位。
//
// 职责：给定一个 agent（含形态），回答「它的可执行入口在哪」。
// 这是五件套里唯一**无 IO 副作用**的一件，故第一个迁。
//
// 分层铁律：本模块只做「按 agent 形态选候选」，**不做平台探测**。
// PATH/注册表/常见路径/shim 解析仍在 platform/os/exec-path.js——那是平台能力，
// agent 域复用它，不复制一份。复制一份就等于把平台差异搬进业务域，
// 将来加平台要改两处。

const path = require('node:path');
const execPath = require('../../../platform/os/exec-path');
const { SANDBOX } = require('../kinds');

// 沙箱化 agent 的入口：每实例独立 install/ 下的 DSH 本体。
// 与原生形态的差别只在「前缀」——原生用共享 npmRoot，沙箱用每实例 installDir。
function sandboxEntry(installDir) {
  if (!installDir) return null;
  // 与 exec-path.dshJsIn 同一拼法：<prefix>/node_modules/<pkg>/lib/bin.js。
  // 用 execPath 的公开能力拼，避免本域自己知道包名布局。
  try { return execPath.dshJsIn(installDir); } catch { return null; }
}

// 原生 agent 的入口候选：全局安装位置 + 运行中进程 + 显式配置的 dshBin。
// 返回数组而非单值：调用方（UI 展示/启动/校验）需要的强度不同，
// 由它们按需取第一个或全部。
function nativeCandidates(opts) {
  const o = opts || {};
  try {
    return execPath.knownDshEntries({
      platform: o.platform,
      env: o.env,
      npmRoot: o.npmRoot,
      dshBin: o.dshBin,
    });
  } catch { return []; }
}

// 统一入口：按 agent 形态分派。
// 注意这里**没有** if (agent.kind === SANDBOX) 之外的形态分支——
// 新增形态只应在 kinds.js 增加，且此处应有对应的一句。
function entryOf(agent, opts) {
  if (!agent) return null;
  const o = opts || {};
  if (agent.kind === SANDBOX) {
    const installDir = o.installDir || (o.root ? path.join(o.root, agent.id, 'install') : null);
    const e = sandboxEntry(installDir);
    return e ? [e] : [];
  }
  return nativeCandidates(o);
}

// 命令形态校验：agent 启动命令是否合法（node + 绝对路径 JS 入口）。
// 委托 platform 层的唯一实现，本域不重复判定规则。
function commandViolation(cmdArr, opts) {
  try {
    return execPath.commandEntryViolation(cmdArr, opts || {});
  } catch (e) {
    return (e && e.message) || String(e);
  }
}

module.exports = { entryOf, sandboxEntry, nativeCandidates, commandViolation };