'use strict';

const { normalizeRemoteAddress, isLoopbackAddress, isPrivateIpv4 } = require('../shared/ip');
const { identify } = require('../platform/security/identity');

module.exports = {
  identify,
  normalizeRemoteAddress,
  isPrivateIpv4,
  isLoopbackAddress,
};
