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

// 受管子进程登记：请壳把这个 pid 纳入「壳退即全杀」的 job。
//
// 为什么需要：壳侧 job（`bounded.rs` 的 `bind_kill_on_close`）只 assign 壳自己 spawn
// 的那一个进程句柄，**不覆盖进程树** ⇒ 内核 spawn 的后代（DSH / router / lan / frpc /
// 沙箱）默认不在 job 内。本调用让壳逐个把它们 assign 进去。
//
// 与 register/setDesired 的差别：后两者由节拍反复调，本调用在 spawn 成功后**一次性**调
// ⇒ **不做重试**（重试会让一个已退出的 pid 反复上报，而 job assign 对已死进程无意义）。
//
// 语义归属：内核只说「这个子进程请壳看住」，不说它是什么业务角色——「受管对象」这个
// 概念只存在于壳侧（进程所有权的持有方）。
function keepAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  return post('/pm/keep-alive', { pid: n });
}

module.exports = {
  FILE_NAME,
  SUPPORTED_SCHEMA,
  file,
  endpoint,
  setEventSink,
  keepAlive,
  register(desc) { return post('/pm/register', desc); },
  setDesired(id, desired) { return post('/pm/set-desired', { id, desired }); },
  onPhase(id, phase) { return post('/pm/on-phase', { id, phase }); },
  recordExit(id, code, signal, startupFailure) { return post('/pm/record-exit', { id, code, signal, startup_failure: startupFailure === true }); },
};
