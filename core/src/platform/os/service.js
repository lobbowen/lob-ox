'use strict';

const { portable } = require('./portable');
const OUTCOME = require('../../shared/outcome');

class CapabilityError extends Error {
  constructor(msg) { super(msg); this.name = 'CapabilityError'; this.code = 'CAPABILITY_UNSUPPORTED'; }
}

const PLATFORM = process.platform;

const UNSUPPORTED_KIND = 'none';

function unsupported() {
  const fail = (m) => () => { throw new CapabilityError('无服务管理器：' + m); };
  return {
    kind: UNSUPPORTED_KIND,
    supportsUnits: false,
    supportsTransient: false,

    
    supports() { return false; },

    daemonReload: fail('daemonReload'),
    resetFailed: fail('resetFailed'),

    startTransient: fail('startTransient'),
    stopUnit: fail('stopUnit'),
    isUnitActive: () => OUTCOME.UNKNOWN,
    transientUnitFile: () => null,
    cleanTransient: fail('cleanTransient'),
    setLimits: () => false,
  };
}

const NONE = unsupported();

function current() {
  if (PLATFORM === 'linux' || PLATFORM === 'darwin' || PLATFORM === 'win32') return portable;
  return NONE;
}

module.exports = {
  current,
  CapabilityError,
  kind: () => current().kind,
  PLATFORM,
  _testProviders: { portable, NONE },
};
