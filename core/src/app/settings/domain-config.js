'use strict';



const SHARED = require('../../shared/shared-constants');

const defaults = [
  {
    at: 'portPools',
    values: {
      routerCtlPort: SHARED.net.routerCtlPort,
      lanCtlPort: SHARED.net.lanCtlPort,
    },
  },
  {
    at: 'corePackageName',
    values: {
      routerAutostart: false,
    },
  },
];

const aliases = [
  ['switcherAutoStart', 'routerAutostart'],
];

function extension() {
  return {
    defaults: defaults.map((g) => ({ at: g.at, values: Object.assign({}, g.values) })),
    aliases: aliases.map((a) => a.slice()),
  };
}

module.exports = { extension, defaults, aliases };
