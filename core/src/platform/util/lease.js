'use strict';

const fs = require('node:fs');
const pidlookup = require('../os/pidlookup');

const STALE_MS = 15000;

function acquireSync(state, key) {
  if (!state[key]) { state[key] = true; return true; }
  return false;
}

function releaseSync(state, key) {
  state[key] = false;
}

function lockRecyclable(lockFile, staleMs) {
  let raw;
  try { raw = fs.readFileSync(lockFile, 'utf8'); } catch { return true; }   
  const pid = parseInt(String(raw).trim(), 10);
  if (!Number.isInteger(pid) || pid <= 0) return true;                      
  const st = pidlookup.probeAlive(pid);
  if (st === 'alive') return false;                                          
  if (st === 'unknown') {
    
    try {
      const fst = fs.statSync(lockFile);
      return fst.mtimeMs < Date.now() - (staleMs || STALE_MS);
    } catch { return true; }
  }
  return true;                                                               
}

function lockHolder(lockFile) {
  try {
    const n = parseInt(fs.readFileSync(lockFile, 'utf8').trim(), 10);
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch { return null; }
}

function stampOf(file) {
  try {
    const st = fs.statSync(file);
    return st.mtimeMs + ':' + st.size;
  } catch { return null; }
}

function stampChanged(file, expected) {
  if (!expected) return false;
  return stampOf(file) !== expected;
}

module.exports = {
  STALE_MS,
  acquireSync, releaseSync,
  lockRecyclable, lockHolder,
  stampOf, stampChanged,
};
