'use strict';

const { createServer } = require('./transport/server');

const { originAllowed, isLoopbackHost, isShellOrigin } = require('./security');

module.exports = { createServer, originAllowed, isLoopbackHost, isShellOrigin };
