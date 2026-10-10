'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const stateRoot = require('../service/state-root');

const FILE_NAME = 'guard-mgmt.json';
const SUPPORTED_SCHEMA = 1;
const HOST = '127.0.0.1';
const TIMEOUT_MS = 1500;

function file() {
  return path.join(stateRoot.supervisorDir(), FILE_NAME);
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return false; }
}

function endpoint() {
  let text;
  try {
    text = fs.readFileSync(file(), 'utf8');
  } catch {
    return null;
  }
  let j;
  try {
    j = JSON.parse(text);
  } catch {
    return null;
  }
  if (!j || typeof j !== 'object' || j.schema !== SUPPORTED_SCHEMA) return null;
  const port = Number(j.port);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  if (!pidAlive(Number(j.pid))) return null;
  return { port, host: typeof j.host === 'string' && j.host ? j.host : HOST };
}

function post(route, payload) {
  const ep = endpoint();
  if (!ep) return false;
  let body;
  try {
    body = JSON.stringify(payload || {});
  } catch {
    return false;
  }
  const req = http.request(
    { host: ep.host, port: ep.port, path: route, method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      timeout: TIMEOUT_MS },
    (res) => { res.resume(); },
  );
  req.on('timeout', () => { try { req.destroy(); } catch {} });
  req.on('error', () => {});
  try {
    req.end(body);
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  FILE_NAME,
  SUPPORTED_SCHEMA,
  file,
  endpoint,
  
  register(desc) { return post('/pm/register', desc); },
  setDesired(id, desired) { return post('/pm/set-desired', { id, desired }); },
  onPhase(id, phase) { return post('/pm/on-phase', { id, phase }); },
  recordExit(id, code, signal, startupFailure) { return post('/pm/record-exit', { id, code, signal, startup_failure: startupFailure === true }); },
  requestRestart(id) { return post('/pm/request-restart', { id }); },
  resetBackoff(id) { return post('/pm/reset-backoff', { id }); },
};
