'use strict';

const RAW = require('../../../shared/shared-constants.json');

if (RAW.schema !== 1) {
  throw new Error('shared-constants: 不支持的 schema ' + RAW.schema + '（期望 1）');
}

module.exports = Object.freeze({
  schema: RAW.schema,
  product: Object.freeze(RAW.product),
  state: Object.freeze(RAW.state),
  env: Object.freeze(RAW.env),
  proc: Object.freeze(RAW.proc),
  bridge: Object.freeze(RAW.bridge),
  net: Object.freeze({
    apiPort: RAW.net.apiPort,
    routerCtlPort: RAW.net.routerCtlPort,
    lanCtlPort: RAW.net.lanCtlPort,
    deprecatedApiPorts: Object.freeze(RAW.net.deprecatedApiPorts.slice()),
    dshDefaultPort: RAW.net.dshDefaultPort,
  }),
  runtime: Object.freeze(RAW.runtime),
});
