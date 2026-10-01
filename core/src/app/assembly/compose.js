'use strict';

const { installFacets } = require('./facets');
const { composeCore } = require('./compose/core');
const { composeDomains } = require('./compose/domains');
const { composeObservers } = require('./compose/observers');

function composeSystem(host, rawConfig, configPath, deps) {
  installFacets(host, deps);
  composeCore(host, rawConfig, configPath);
  composeDomains(host);
  composeObservers(host);
  return host;
}

module.exports = { composeSystem };
