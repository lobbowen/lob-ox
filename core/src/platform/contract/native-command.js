'use strict';

const fs = require('node:fs');
const dshCli = require('./dsh-cli');
const execPath = require('../os/exec-path');

function resolveBareCommand(command) {
  if (!Array.isArray(command) || command.length === 0) return command;
  const idx = command.length > 1 ? 1 : 0;
  const cur = command[idx];
  // isBareCommand 从 agent 域来（那是它的单一实现，app/native 的副本已删）。
  // 判据：不含路径分隔且不以 ~ 开头 = 裸命令（依赖 PATH 解析）。
  const status = require('../../domains/agent/status');
  if (!status.isBareCommand(cur)) return command;
  const d = execPath.resolveDsh();
  if (!d || !d.bin) return command;
  const rest = command.slice(idx + 1);
  return d.isJs ? [d.runtime || process.execPath, d.bin, ...rest] : [d.bin, ...rest];
}
function nativeCommand(config, pluginManager) {
  const command = resolveBareCommand(config.command || []);
  const patchFile = (pluginManager && pluginManager.overlayFile && fs.existsSync(pluginManager.overlayFile))
    ? pluginManager.overlayFile
    : null;

  const out = [];
  let portSet = false;
  for (let i = 0; i < command.length; i += 1) {
    const a = String(command[i]);
    if (a === '--port' || a === '-p') {
      
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
