'use strict';

const stateRoot = require('../../platform/service/state-root');

const fs = require('node:fs');
const path = require('node:path');
const { writeAtomic } = require('../../platform/util/fs');
const { deriveState } = require('./core');

function shellDir() {
  return stateRoot.shellDir();
}

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function writeJson(p, v) {
  const dir = path.dirname(p);
  fs.mkdirSync(dir, { recursive: true });
  writeAtomic(p, JSON.stringify(v, null, 2) + '\n', { mode: 0o600 });
}

function identity() {
  return readJson(path.join(shellDir(), 'identity.json'));
}

function journalPath() { return path.join(shellDir(), 'update-journal.json'); }
function readJournal() {
  return readJson(journalPath()) || {
    from: null, to: null, confirmed: false,
    startedAt: null, lastAttemptAt: null,
  };
}
function writeJournal(j) { writeJson(journalPath(), j); }

function markPending(from, to) {
  const j = readJournal();
  j.from = from || j.from;
  j.to = to;
  j.confirmed = false;
  j.startedAt = new Date().toISOString();
  writeJournal(j);
  return j;
}

function evaluate() {
  const id = identity();
  const j = readJournal();
  const view = deriveState(id, j);
  if (view.state === 'confirmed' && j.confirmed !== true) writeJournal(view.journal);
  return view;
}

function health(payload) {
  const p = payload || {};
  const dir = shellDir();
  fs.mkdirSync(dir, { recursive: true });
  const idp = path.join(dir, 'identity.json');
  const id = readJson(idp) || {};
  if (p.phase) id.phase = String(p.phase);
  if (p.version) id.version = String(p.version);
  id.lastSeenAt = new Date().toISOString();
  writeJson(idp, id);

  const ev = evaluate();
  return { ok: true, phase: id.phase || null, state: ev.state, target: ev.target || null };
}

function status() {
  const id = identity();
  const ev = evaluate();
  const j = readJournal();
  return {
    identity: id,
    journal: j,
    state: ev.state,
    reason: ev.reason || null,
    dir: shellDir(),
  };
}

module.exports = { shellDir, identity, readJournal, markPending, evaluate, health, status };
