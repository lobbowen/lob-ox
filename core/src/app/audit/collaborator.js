'use strict';

const { orphanAudit } = require('./orphan-scan');

function createOrphanScan(deps) {
  const g = deps || {};
  const last = { key: null, at: 0 };
  const getLastKey = typeof g.getLastKey === 'function' ? g.getLastKey : () => last.key;
  const setLastKey = typeof g.setLastKey === 'function' ? g.setLastKey : (v) => { last.key = v; };
  const getLastAt = typeof g.getLastAt === 'function' ? g.getLastAt : () => last.at;
  const setLastAt = typeof g.setLastAt === 'function' ? g.setLastAt : (v) => { last.at = v; };
  return {
    orphan() {
      return orphanAudit({
        getConfig: g.getConfig,
        getLogger: g.getLogger,
        getEvents: g.getEvents,
        getInstances: g.getInstances,
        getManagedObjects: g.getManagedObjects,
        getCtl: g.getCtl,
        getDaemons: g.getDaemons,
        getStopping: g.getStopping,
        getLastKey, setLastKey, getLastAt, setLastAt,
      });
    },
  };
}

module.exports = { createOrphanScan };
