'use strict';

// HTTP 请求身份判定（请求到 socket 事实）。纯 IP 事实（normalize/isLoopback/isPrivateIpv4）
// 在 src/shared/ip.js，此处只放消费 req 的 HTTP 部分，避免传输层概念污染 L0 纯函数层。
// 信任根唯一：req.socket.remoteAddress（操作系统连接事实，客户端无法伪造）；
// 请求头（Host/Origin/Referer）是浏览器语义数据，绝不参与身份或鉴权判定。

// 复用 shared/ip 的唯一实现，绝不在此重写第二份 IP 判定。platform 到 shared 是允许的向下依赖，
// 已在 test/layering-and-dependency-gate-test.js 的 CROSS_LAYER 登记。
const { normalizeRemoteAddress, isLoopbackAddress } = require('../../shared/ip');

/** 是否来自本机回环（socket 事实）。 */
function socketIsLoopback(req) {
  return isLoopbackAddress(req && req.socket && req.socket.remoteAddress);
}

/** 请求身份快照（每请求一次，分派器写入 ctx；域内不得重复判定）。
 *  只保留真正被消费的字段：remote（诊断/日志用）、loopback（token 下发与 access-key 豁免依据）。 */
function identify(req) {
  return {
    remote: normalizeRemoteAddress(req && req.socket && req.socket.remoteAddress),
    loopback: socketIsLoopback(req),
  };
}

module.exports = { identify };
