'use strict';

const ports = require('../../platform/service/ports');

const POOLS = {
  providerApi: { base: 24000, count: 2000 },
};

const SEGMENTS = {
  proxyInstance: { pool: 'managed', anchor: 1000 },
  oauthCallback: { pool: 'managed', anchor: 2000 },
  providerApi: { pool: 'providerApi', anchor: 0 },
};

const OWNER_PREFIXES = ['proxy:', 'providerApi:'];

ports.registerPools(POOLS);
ports.registerSegment(SEGMENTS);

module.exports = { POOLS, SEGMENTS, OWNER_PREFIXES };
