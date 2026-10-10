'use strict';

const fs = require('node:fs');
const dshCli = require('../../platform/contract/dsh-cli');

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
