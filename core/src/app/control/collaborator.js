'use strict';

// app/control/collaborator.js —— Control 协作方工厂（真 ctor 注入）。
// createControlPlane(deps) 组合视图投影与申报工厂，自己持有实现；
// 可只 require 本模块 + 假 deps 直接断言。

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
