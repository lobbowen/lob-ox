'use strict';

const { execFileSync, execFile } = require('node:child_process');

const DEFAULT_TIMEOUT_MS = 15000;

const DEFAULT_MAX_BUFFER = 8 * 1024 * 1024;

function options(opts) {
  const o = opts || {};
  return {
    timeout: o.timeoutMs || DEFAULT_TIMEOUT_MS,
    killSignal: o.killSignal || 'SIGKILL',
    maxBuffer: o.maxBuffer || DEFAULT_MAX_BUFFER,
    stdio: o.stdio || ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    ...(o.encoding ? { encoding: o.encoding } : {}),
    ...(o.cwd ? { cwd: o.cwd } : {}),
    ...(o.env ? { env: o.env } : {}),
    ...(o.input !== undefined ? { input: o.input } : {}),
  };
}

// 命令失败告警的唯一出口：run / runAsync / runDetail 共用，杜绝"失败静默"。
// opts.logger 缺失时退回 console.error（platform/service/log/events.js 的既有范式）——
// 调用点（如 os/file-protect 的 icacls 凭据收口）不传 logger 也必须留下痕迹。
function warnExecFailure(opts, tag, bin, args, err) {
  const line = '[exec] ' + tag + bin + ' ' + (args || []).join(' ').slice(0, 80) +
    ' failed: ' + ((err && err.message) || err);
  try {
    if (opts && opts.logger && opts.logger.warn) opts.logger.warn(line);
    else console.error(line);
  } catch {}
}

function run(bin, args, opts) {
  const o = opts || {};
  try {
    const out = execFileSync(bin, args, options(o));
    if (out === null || out === undefined) {
      return o.encoding ? '' : Buffer.alloc(0);
    }
    return out;
  } catch (e) {
    warnExecFailure(o, '', bin, args, e);
    return null;
  }
}

function runOut(bin, args, opts) {
  const o = Object.assign({}, opts || {}, { encoding: 'utf8' });
  const r = run(bin, args, o);
  if (r === null) return null;
  try { return String(r); } catch { return null; }
}

// 失败 -> 结果对象：runAsync 与 runDetail 的唯一实现。返回形状固定，
// 全部调用点（autostart/*、os/file-protect 等）都按 ok/code/stdout/stderr/timedOut/error 读取。
function failureResult(err) {
  const timedOut = !!(err && (err.code === 'ETIMEDOUT' || err.signal === 'SIGKILL' ||
    /ETIMEDOUT|timed? ?out/i.test(String(err && err.message))));
  return {
    ok: false,
    code: (err && err.status != null) ? String(err.status) : null,
    stdout: String((err && err.stdout) || ''),
    stderr: String((err && err.stderr) || ''),
    timedOut,
    error: (err && err.message) ? String(err.message) : String(err),
  };
}

function runAsync(bin, args, opts) {
  const o = opts || {};
  return new Promise((resolve) => {
    const fail = (err) => {
      warnExecFailure(o, '(async) ', bin, args, err);
      resolve(failureResult(err));
    };
    try {
      execFile(bin, args, Object.assign({}, options(o), { encoding: 'utf8' }), (err, stdout, stderr) => {
        if (!err) {
          resolve({ ok: true, code: '0', stdout: String(stdout == null ? '' : stdout), stderr: String(stderr == null ? '' : stderr), timedOut: false, error: null });
          return;
        }
        err.stdout = stdout; err.stderr = stderr;
        fail(err);
      });
    } catch (e) { fail(e); }
  });
}

function runOutAsync(bin, args, opts) {
  return runAsync(bin, args, opts).then((r) => (r.ok ? r.stdout : null));
}

function runDetail(bin, args, opts) {
  const o = opts || {};
  try {
    const out = execFileSync(bin, args, options(Object.assign({}, o, { encoding: 'utf8' })));
    return { ok: true, code: '0', stdout: String(out || ''), stderr: '', timedOut: false, error: null };
  } catch (e) {
    warnExecFailure(o, '(detail) ', bin, args, e);
    return failureResult(e);
  }
}

module.exports = { run, runOut, runOutAsync, runDetail, runAsync, options, DEFAULT_TIMEOUT_MS };
