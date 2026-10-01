'use strict';

// `//` 分支必须先于「无协议头」分支匹配，且用户名/密码不跨 `/`，否则 http://u:p@h 会把 `//u:p` 整段当密码吃掉。
function maskProxyServer(server) {
  return server ? String(server).replace(/(\/\/)?([^\s/@:]+):([^\s/@]*)@/, '$1$2:***@') : null;
}

function maskProxySecrets(text) {
  return String(text == null ? '' : text).replace(/(\/\/)?([^\s/@:]+):([^\s/@]*)@/g, '$1$2:***@');
}

module.exports = { maskProxyServer, maskProxySecrets };
