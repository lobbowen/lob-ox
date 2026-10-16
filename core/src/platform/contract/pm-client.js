'use strict';

const fs = require('node:fs');
const SHARED = require('../../shared/shared-constants');
const path = require('node:path');
const http = require('node:http');
const stateRoot = require('../service/state-root');
const pidlookup = require('../os/pidlookup');

const FILE_NAME = 'guard-mgmt.json';
const SUPPORTED_SCHEMA = 1;
const HOST = '127.0.0.1';
const TIMEOUT_MS = 1500;

let eventSink = null;
function setEventSink(fn) {
  eventSink = typeof fn === 'function' ? fn : null;
}

function file() {
  return path.join(stateRoot.supervisorDir(), FILE_NAME);
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  return pidlookup.probeAlive(pid) === 'alive';
}

function probeEndpoint() {
  let text;
  try {
    text = fs.readFileSync(file(), 'utf8');
  } catch (e) {
    return {
      ep: null,
      problem: (e && e.code) === 'ENOENT' ? 'contract-file-missing' : 'contract-file-unreadable',
      detail: (e && e.code) || String(e),
    };
  }
  let j;
  try {
    j = JSON.parse(text);
  } catch {
    return { ep: null, problem: 'contract-file-bad-json', detail: null };
  }
  if (!j || typeof j !== 'object') {
    return { ep: null, problem: 'contract-file-bad-shape', detail: null };
  }
  if (j.schema !== SUPPORTED_SCHEMA) {
    return { ep: null, problem: 'contract-schema-mismatch', detail: 'schema=' + JSON.stringify(j.schema) };
  }
  const port = Number(j.port);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    return { ep: null, problem: 'contract-port-invalid', detail: 'port=' + JSON.stringify(j.port) };
  }
  if (!pidAlive(Number(j.pid))) {
    return { ep: null, problem: 'contract-owner-dead', detail: 'pid=' + JSON.stringify(j.pid) };
  }
  const token = typeof j.token === 'string' ? j.token : '';
  if (!token) {
    return { ep: null, problem: 'contract-token-empty', detail: null };
  }
  return { ep: { port, host: typeof j.host === 'string' && j.host ? j.host : HOST, token }, problem: null, detail: null };
}

function endpoint() {
  return probeEndpoint().ep;
}

let lastNote = null;
function note(type, data) {
  if (!eventSink) return;
  const key = type + '|' + JSON.stringify(data);
  if (key === lastNote) return;
  lastNote = key;
  try { eventSink(type, data); } catch {}
}

function post(route, payload) {
  const found = probeEndpoint();
  if (!found.ep) {
    note('pm_endpoint_unavailable', { problem: found.problem, detail: found.detail });
    return false;
  }
  const ep = found.ep;
  let body;
  try {
    body = JSON.stringify(payload || {});
  } catch (e) {
    note('pm_payload_unserializable', { error: (e && e.message) || String(e) });
    return false;
  }
  const req = http.request(
    { host: ep.host, port: ep.port, path: route, method: 'POST',
      // 令牌头名走 shared-constants 单源（此前与 mgmt.rs 各自硬编码，改一侧漏一侧）。
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), [SHARED.bridge.mgmtTokenHeader]: ep.token },
      timeout: TIMEOUT_MS },
    (res) => { res.resume(); },
  );
  req.on('timeout', () => { try { req.destroy(); } catch {} });
  req.on('error', (err) => {
    note('pm_request_failed', { code: (err && err.code) || null, message: (err && err.message) || String(err) });
  });
  try {
    req.end(body);
    return true;
  } catch (e) {
    note('pm_send_failed', { error: (e && e.message) || String(e) });
    return false;
  }
}

module.exports = {
  FILE_NAME,
  SUPPORTED_SCHEMA,
  file,
  endpoint,
  setEventSink,
  register(desc) { return post('/pm/register', desc); },
  setDesired(id, desired) { return post('/pm/set-desired', { id, desired }); },
  onPhase(id, phase) { return post('/pm/on-phase', { id, phase }); },
  recordExit(id, code, signal, startupFailure) { return post('/pm/record-exit', { id, code, signal, startup_failure: startupFailure === true }); },
};
