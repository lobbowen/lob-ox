'use strict';

function maskProxyServer(server) {
  return server ? String(server).replace(/(\/\/)?([^\s/@:]+):([^\s/@]*)@/, '$1$2:***@') : null;
}

function maskProxySecrets(text) {
  return String(text == null ? '' : text).replace(/(\/\/)?([^\s/@:]+):([^\s/@]*)@/g, '$1$2:***@');
}

module.exports = { maskProxyServer, maskProxySecrets };
