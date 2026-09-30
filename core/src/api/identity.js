'use strict';

// api/identity —— re-export shim（DIRECTORY-STRUCTURE-DESIGN）：纯 IP 事实转出 src/shared/ip.js，HTTP 身份转出 src/platform/security/identity.js。
// 生产侧 api/security.js、api/transport/server.js 与 test/relay-source-gate-test.js、test/lan-access-boundary-test.js 仍按本路径 require；
// 上述消费方全部改直引真实归属前本文件只做 re-export，不得写入任何判定逻辑（否则又成「同一事实两份实现」）。

const { normalizeRemoteAddress, isLoopbackAddress, isPrivateIpv4 } = require('../shared/ip');
const { identify } = require('../platform/security/identity');

module.exports = {
  identify,
  normalizeRemoteAddress,
  isPrivateIpv4,
  isLoopbackAddress,
};
