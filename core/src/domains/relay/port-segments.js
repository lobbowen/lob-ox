'use strict';

const ports = require('../../platform/service/ports');

const SEGMENTS = {
  relay: { pool: 'managed', anchor: 0 },
};

ports.registerSegment(SEGMENTS);

module.exports = {};
