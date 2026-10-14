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

function run(bin, args, opts) {
  const o = opts || {};
  try {
    const out = execFileSync(bin, args, options(o));
    if (out === null || out === undefined) {
      return o.encoding ? '' : Buffer.alloc(0);
    }
    return out;
  } catch (e) {
    if (o.logger && o.logger.warn) {
      try {
        o.logger.warn('[exec] ' + bin + ' ' + (args || []).join(' ').slice(0, 80) +
          ' failed: ' + ((e && e.message) || e));
      } catch {}
    }
    return null;
  }
}

function runOut(bin, args, opts) {
  const o = Object.assign({}, opts || {}, { encoding: 'utf8' });
  const r = run(bin, args, o);
  if (r === null) return null;
  try { return String(r); } catch { return null; }
}

function runAsync(bin, args, opts) {
  const o = opts || {};
  return new Promise((resolve) => {
    const fail = (err) => {
      if (o.logger && o.logger.warn) {
        try {
          o.logger.warn('[exec] (async) ' + bin + ' ' + (args || []).join(' ').slice(0, 80) +
            ' failed: ' + ((err && err.message) || err));
        } catch {}
      }
      const timedOut = !!(err.code === 'ETIMEDOUT' || err.signal === 'SIGKILL' ||
        /ETIMEDOUT|timed? ?out/i.test(String(err && err.message)));
      resolve({
        ok: false,
        code: err.status != null ? String(err.status) : null,
        stdout: String(err.stdout || ''),
        stderr: String(err.stderr || ''),
        timedOut,
        error: (err && err.message) ? String(err.message) : String(err),
      });
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
    const timedOut = !!(e && (e.code === 'ETIMEDOUT' || e.signal === 'SIGKILL' ||
      /ETIMEDOUT|timed? ?out/i.test(String(e && e.message))));
    return {
      ok: false,
      code: (e && e.status != null) ? String(e.status) : null,
      stdout: String((e && e.stdout) || ''),
      stderr: String((e && e.stderr) || ''),
      timedOut,
      error: (e && e.message) ? String(e.message) : String(e),
    };
  }
}

module.exports = { run, runOut, runOutAsync, runDetail, runAsync, options, DEFAULT_TIMEOUT_MS };
