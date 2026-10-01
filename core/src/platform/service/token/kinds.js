'use strict';

const KINDS = {};
const KIND_ORDER = [];

function registerKind(name, def) {
  if (typeof name !== 'string' || !name) return false;
  if (!Object.prototype.hasOwnProperty.call(KINDS, name)) KIND_ORDER.push(name);
  KINDS[name] = def;
  return true;
}

function setKinds(map) {
  for (const k of Object.keys(KINDS)) delete KINDS[k];
  KIND_ORDER.length = 0;
  if (map && typeof map === 'object') {
    for (const k of Object.keys(map)) registerKind(k, map[k]);
  }
}

const GHOST_KEYS = ['lanToken'];

function isKnownKind(kind) {
  return Object.prototype.hasOwnProperty.call(KINDS, kind);
}

function kindOf(kind) {
  return isKnownKind(kind) ? KINDS[kind] : null;
}

function isPersistent(kind) {
  const k = kindOf(kind);
  return !!(k && k.persistent);
}

function isCaptured(kind) {
  const k = kindOf(kind);
  return !!(k && k.captured);
}

function isUserConfigKind(kind) {
  const k = kindOf(kind);
  return !!(k && k.side === 'user');
}

module.exports = {
  KINDS,
  GHOST_KEYS,
  registerKind,
  setKinds,
  isKnownKind,
  isPersistent,
  isCaptured,
  isUserConfigKind,
};
