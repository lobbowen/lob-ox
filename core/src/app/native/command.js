'use strict';

const fs = require('node:fs');
const dshCli = require('../../platform/contract/dsh-cli');

function nativeCommand(config, pluginManager) {
  const command = config.command || [];
  const [runtime, bin, ...rest] = command;
  let parts = command;
  if (pluginManager && pluginManager.overlayFile && fs.existsSync(pluginManager.overlayFile)) {
    const sub = rest.length > 0 ? String(rest[0]) : '';
    if (sub && !sub.startsWith('-')) {
      parts = [runtime, bin, sub, '--patch', pluginManager.overlayFile, ...rest.slice(1)];
    } else {
      parts = [runtime, bin, '--patch', pluginManager.overlayFile, ...rest];
    }
  }
  const out = [];
  let portSet = false;
  for (let i = 0; i < parts.length; i++) {
    const a = String(parts[i]);
    if (a === '--port' || a === '-p') {
      out.push(a, String(config.targetPort)); i++; portSet = true;
    } else if (/^--port=/.test(a)) {
      out.push('--port=' + config.targetPort); portSet = true;
    } else {
      out.push(parts[i]);
    }
  }
  if (!portSet && config.targetPort) out.push('--port', String(config.targetPort));
  return dshCli.withoutAutoOpen(out);
}

module.exports = { nativeCommand };
