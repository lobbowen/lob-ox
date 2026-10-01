'use strict';

const core = require('./core');
const { PortRegistry } = require('./pool');

const shared = new PortRegistry();
core.bindShared(shared);

module.exports = {
  PortRegistry, shared,
  BASE_POOLS: core.BASE_POOLS,
  DEFAULT_POOLS: core.DEFAULT_POOLS,
  SEGMENT_POOL: core.SEGMENT_POOL,
  registerPools: core.registerPools,
  registerSegment: core.registerSegment,
};
