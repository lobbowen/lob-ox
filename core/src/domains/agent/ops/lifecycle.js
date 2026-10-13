'use strict';

// agent 启停（五件套之五）。
//
// 边界判断：本模块**不**收拢 domains/instance/lifecycle.js。
// 那个文件与沙箱实例深度耦合（store.instances / governor 配额 / stateMachine 相位 /
// sandbox.launchCtx / systemd unit 命名），它是「沙箱实例」这一种形态的进程编排，
// 不是 agent 通用生命周期。把它整个搬过来会把 instance 的耦合带进 agent 域。
//
// 本模块的职责窄得多：**按形态选启动方式**，并把就绪判定收拢为单一实现。
//   - 命令怎么来：ops/entry.js 已回答（入口定位）
//   - env 怎么来：runtime/sandbox-env.js 已回答（沙箱重定向，原生不重定向）
//   - 谁来拉起：service 层（壳进程管理 / systemd），由调用方注入
//   - 就绪与否：ready() 是全仓唯一实现，见下
//
// 就绪判据分层（这是原实现散在三处的判据，收拢后只有一份）：
//   端口通        必要不充分——只能回答「有人在听」
//   /healthz 2xx  充分——回答「可服务」
//   会话态         上层问题，不属于就绪判定

const http = require('node:http');

const READINESS_TIMEOUT_MS = 800;

/**
 * 就绪判定：TCP 可达 + /healthz 返回 2xx。
 * 返回四种互斥结果，调用方必须分别处理——合成一个 bool 会丢失可操作信息。
 */
async function ready(port, opts) {
  const o = opts || {};
  const timeoutMs = o.timeoutMs || READINESS_TIMEOUT_MS;
  const path = o.healthPath || '/healthz';
  const r = await httpProbe(port, path, timeoutMs);
  if (r.connected === false) return { state: 'port-closed' };
  if (r.status === null) return { state: 'no-http-response' };
  if (r.status >= 200 && r.status < 300) return { state: 'ready' };
  return { state: 'http', status: r.status };
}

function httpProbe(port, path, timeoutMs) {
  return new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path,
      method: 'GET',
      timeout: timeoutMs,
    }, (res) => {
      let n = 0;
      res.on('data', (c) => { n += c.length; if (n > 4096) { try { req.destroy(); } catch {  } } });
      res.on('end', () => resolve({ connected: true, status: res.statusCode || null }));
    });
    req.on('timeout', () => { try { req.destroy(); } catch {  } });
    req.on('error', (e) => {
      // ECONNREFUSED = 端口没人听；其余（超时等）= 有人在但没应答
      if (e && (e.code === 'ECONNREFUSED' || e.code === 'EHOSTUNREACH')) resolve({ connected: false, status: null });
      else resolve({ connected: true, status: null });
    });
    req.end();
  });
}

/**
 * 按形态取启动 env。
 * 原生：不重定向（与壳同用户同环境，重定向反而破坏它）。
 * 沙箱：runtime/sandbox-env.js 全量重定向。
 */
function envFor(agent, dirs, opts) {
  const o = opts || {};
  if (!agent || agent.kind !== 'sandbox') {
    return { env: {}, workingDir: o.workingDir || null };
  }
  const sandboxEnv = require('../runtime/sandbox-env');
  const r = sandboxEnv.sandboxEnv(dirs || {});
  return { env: r.env, workingDir: r.workingDir || (o.workingDir || null) };
}

/**
 * 启动：把「入口 + env + 拉起器」拼起来交给 service 层。
 * 本函数不做进程操作——那归壳的进程管理（Y 模式：进程所有权归底座）。
 * @param {object} spec
 * @param {object} spec.agent      agent 记录（至少 { id, kind }）
 * @param {string[]} spec.entry    入口命令（来自 ops/entry.entryOf）
 * @param {object} spec.dirs       { data, install, nodeModules, tmp }
 * @param {object} spec.service    拉起器 { startTransient(spec) }
 * @param {string} [spec.unit]     unit 名（沙箱用 dsh-web@<id>）
 * @param {number} [spec.port]
 * @param {string[]} [spec.anchors]
 * @param {string} [spec.pidFile]
 * @returns {Promise<{ok:boolean,error:string|null}>}
 */
async function start(spec) {
  const s = spec || {};
  const agent = s.agent || {};
  const entry = Array.isArray(s.entry) ? s.entry : [];
  if (!entry.length) return { ok: false, error: 'agent 未配置启动命令（入口未定位）' };
  if (!s.service || typeof s.service.startTransient !== 'function') {
    return { ok: false, error: 'service 拉起器不可用（startTransient 缺失）' };
  }

  const { env, workingDir } = envFor(agent, s.dirs, s);

  // 端口占用检查：登记表里已被别人占就拒绝，不重复拉起。
  if (s.ports && s.port) {
    const taken = s.ports.recordOf(s.port);
    if (taken && taken.owner && taken.owner !== 'agent:' + agent.id) {
      return { ok: false, error: 'PORT_TAKEN:' + (taken.owner || taken.role) };
    }
  }

  try {
    await s.service.startTransient({
      unit: s.unit || ('dsh-web@' + agent.id),
      cmd: entry,
      env,
      workingDir,
      port: s.port || null,
      pidFile: s.pidFile || null,
      anchors: s.anchors || [],
    });
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
  return { ok: true, error: null };
}

/**
 * 停止：交给 service 层，本函数只负责把 ctx 备齐。
 * 就绪判定同样只有一份（见 ready）。
 */
async function stop(spec) {
  const s = spec || {};
  const agent = s.agent || {};
  if (!s.service || typeof s.service.stopUnit !== 'function') {
    return { ok: false, error: 'service 停止器不可用（stopUnit 缺失）' };
  }
  const unit = s.unit || ('dsh-web@' + agent.id);
  let stopped;
  try {
    stopped = await s.service.stopUnit(unit, Object.assign({ timeoutMs: s.timeoutMs || 20000 }, s.launchCtx || {}));
  } catch (e) {
    return { ok: false, error: '停止单元 ' + unit + ' 异常: ' + ((e && e.message) || e) };
  }
  if (stopped === false) {
    return { ok: false, error: '停止 agent 失败（单元 ' + unit + ' 未确认停止）' };
  }
  return { ok: true, error: null };
}

module.exports = { start, stop, ready, envFor, httpProbe };
