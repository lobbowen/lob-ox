'use strict';

const { createRelay } = require('./proxy');
const { LanManager } = require('./ops');
const { FrpManager } = require('./frp');
const { frpPlatformTag, downloadUrls } = require('./frp-install');

module.exports = { createRelay, LanManager, FrpManager, frpPlatformTag, downloadUrls };
