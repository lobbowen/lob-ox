'use strict';

const defaults = [
  {
    at: 'portPools',
    values: {
      routerCtlPort: 43107,
      lanCtlPort: 43108,
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
