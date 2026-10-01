'use strict';

const { normalizeRemoteAddress, isLoopbackAddress } = require('../../shared/ip');

function socketIsLoopback(req) {
  return isLoopbackAddress(req && req.socket && req.socket.remoteAddress);
}

function identify(req) {
  return {
    remote: normalizeRemoteAddress(req && req.socket && req.socket.remoteAddress),
    loopback: socketIsLoopback(req),
  };
}

module.exports = { identify };
