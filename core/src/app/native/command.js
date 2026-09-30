'use strict';

// 领域：原生 DeepSeek Harness（原生 DSH，独立模块，不作为沙箱实例）。
// 与沙箱实例(domain/instance)彻底分开；监控/守护由 domain/monitor + domain/guardian 统一覆盖。

const fs = require('node:fs');
// 真机上自弹浏览器的就是这个主实例命令（旧形态 `… bin.js web --port 3080` 每启一次弹一次），
// 所以该闸必须落在组装口，与沙箱实例共用同一份实现。
const dshCli = require('../../platform/contract/dsh-cli');

/** 组装原生 DSH 启动命令：有插件启停覆盖层时附加 --patch，并统一注入 --port <targetPort>
 *  （已有 --port/-p 则改值，否则追加）。DSH 的 web 子命令带 rejectParentOptions 守卫，
 *  故子命令形态下 --patch 必须紧跟子命令词（dsh web --patch <overlay> ...）；
 *  根选项形态（rest[0] 以 '-' 开头，如 dsh --profile web）保持根级。 */
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
