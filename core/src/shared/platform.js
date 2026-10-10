'use strict';

const PLATFORM = process.platform;

const isLinux = PLATFORM === 'linux';
const isMac = PLATFORM === 'darwin';
const isWindows = PLATFORM === 'win32';

module.exports = { PLATFORM, ARCH: process.arch, isLinux, isMac, isWindows };
