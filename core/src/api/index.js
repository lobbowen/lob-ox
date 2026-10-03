'use strict';

const { createServer } = require('./transport/server');

const { originAllowed, isShellOrigin } = require('./security');

module.exports = { createServer, originAllowed, isShellOrigin };
