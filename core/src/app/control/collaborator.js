'use strict';

const { createProjection } = require('./projection');
const { createSpecs } = require('./specs');

function createControlPlane(deps) {
  const g = deps || {};
  const projection = createProjection({
    getLifecycleManager: g.getLifecycleManager,
    getState: g.getState,
    getManagedObjects: g.getManagedObjects,
  });
  const specs = createSpecs({
    getState: g.getState, getManagedObjects: g.getManagedObjects,
    getInstances: g.getInstances, getConfig: g.getConfig,
    getCtl: g.getCtl, getDaemons: g.getDaemons, getLogger: g.getLogger,
  });
  return {
    syncDshView: projection.syncDshView,
    syncRouterView: projection.syncRouterView,
    syncInstancesView: projection.syncInstancesView,
    sandboxSpec: specs.sandboxSpec,
    upsert: specs.upsert,
    unregister: specs.unregister,
    mainSpec: specs.mainSpec,
    syncManagedRegistry: specs.syncManagedRegistry,
  };
}

module.exports = { createControlPlane };
