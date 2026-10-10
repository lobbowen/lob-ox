'use strict';

// 机箱进程管理端点客户端（Y 模式：底座持有真相，内核单向上报）。
//
// 拓扑约束（与直觉相反，改本文件前必读）：
//   --run-guard 在 Unix 上走 exec 替换（壳进程直接变成 node 内核），Windows 上分离启动。
//   ⇒ 内核与「持有 mgmt 端点的 GUI 壳」是**两个独立进程**，内核启动时壳未必在跑，
//   也不存在「父进程把端口塞进子进程的 env」这条可靠通道（exec 会替换掉壳自己）。
//   故端口发现走**落盘契约**：壳把 guard-mgmt 端口原子写进 <状态根>/supervisor/guard-mgmt.json
//   （范式同壳侧 mirror::export_to_kernel：tmp → rename，所有权在壳、方向单向）。
//
// 降级契约（关键，不得加 throw）：内核是常更新模块、壳是底座，端点是**增强**而非依赖。
//   契约文件缺失 / 端口非法 / 连不上 / 超时 —— 一律静默，绝不影响内核既有行为与返回值。
//   这样即使老壳（还没写该文件）配新内核，也只是「不上报」，不会崩、不会改语义。

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

// 读取端点契约：拿不到就返回 null（调用方静默降级）。
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
  return { port, host: typeof j.host === 'string' && j.host ? j.host : HOST };
}

// 单向上报：fire-and-forget。失败静默（记 debug 级，不上抛），内核业务不受端点影响。
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
  // 下列路由与壳侧 process_manager/mgmt.rs 的路由表一一对应（新增路由需两端同步）。
  register(desc) { return post('/pm/register', desc); },
  setDesired(id, desired) { return post('/pm/set-desired', { id, desired }); },
  onPhase(id, phase) { return post('/pm/on-phase', { id, phase }); },
  recordExit(id, code, signal, startupFailure) { return post('/pm/record-exit', { id, code, signal, startup_failure: startupFailure === true }); },
  requestRestart(id) { return post('/pm/request-restart', { id }); },
  resetBackoff(id) { return post('/pm/reset-backoff', { id }); },
};
