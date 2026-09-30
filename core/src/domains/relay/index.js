'use strict';

// relay 域门面（组合 + 导出，无逻辑）。
// 分层（单向依赖）：index -> ops -> proxy -> tunnel/session -> core；
// ops -> ports / managed / frp -> frp-install。域内文件不得反向 require 本文件。

const { createRelay } = require('./proxy');
const { LanManager } = require('./ops');
const { FrpManager } = require('./frp');
const { frpPlatformTag, downloadUrls } = require('./frp-install');

module.exports = { createRelay, LanManager, FrpManager, frpPlatformTag, downloadUrls };
