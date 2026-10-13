'use strict';

const pidlook = require('../../platform/os/pidlookup');

function startDeadlinePassed(deadline, now) {
  return !!(deadline && now > deadline);
}

function childAlive(child) {
  return !!(child && child.exitCode === null && child.signalCode === null);
}
function adoptedAlive(adoptPid) {
  return adoptPid !== null && adoptPid !== undefined && pidlook.isAlive(adoptPid);
}

function targetAlive(child, adoptPid) {
  return childAlive(child) || adoptedAlive(adoptPid);
}

module.exports = {
  methods: {
  },
  startDeadlinePassed, childAlive, adoptedAlive, targetAlive,
};
