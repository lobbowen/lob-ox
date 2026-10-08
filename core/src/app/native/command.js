'use strict';

const fs = require('node:fs');
const dshCli = require('../../platform/contract/dsh-cli');

/**
 * 生成原生 DSH 的 spawn 命令。
 *
 * overlay（插件状态补丁）此前是**事后 splice**：此处 fs.existsSync 判存再插 --patch，
 * 而 spawn 发生在别处 ⇒ 判存与真正 spawn 之间存在 TOCTOU；且 overlay 不是命令模型的一等公民，
 * 于是"首次启用插件"会让下一次 spawn 静默多出 --patch（无日志）。
 *
 * 现在 overlay 在**本函数构造期**定格（判存与生成同一处），TOCTOU 消除。
 * 命令结构由配置决定，此处不重新解释"谁是 runtime / bin / subcommand"（旧逻辑也不解释）。
 *
 * 只做两件事（与旧逻辑等价，实测 6 个形态逐一比对）：
 *   1. 剔除 command 里既有的 --port / -p / --port= 形式，再统一注入 targetPort（覆盖语义）
 *   2. 注入 --patch
 */
function nativeCommand(config, pluginManager) {
  const command = config.command || [];
  const patchFile = (pluginManager && pluginManager.overlayFile && fs.existsSync(pluginManager.overlayFile))
    ? pluginManager.overlayFile
    : null;

  const out = [];
  let portSet = false;
  for (let i = 0; i < command.length; i += 1) {
    const a = String(command[i]);
    if (a === '--port' || a === '-p') {
      // 覆盖：保留标记形式，值统一为 targetPort（与旧逻辑逐字相同）
      out.push(a, String(config.targetPort)); i += 1; portSet = true;
    } else if (/^--port=/.test(a)) {
      out.push('--port=' + config.targetPort); portSet = true;
    } else {
      out.push(command[i]);
    }
  }
  if (!portSet && config.targetPort) out.push('--port', String(config.targetPort));
  if (patchFile) out.push('--patch', patchFile);
  return dshCli.withoutAutoOpen(out);
}

module.exports = { nativeCommand };
