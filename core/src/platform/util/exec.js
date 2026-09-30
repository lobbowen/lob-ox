'use strict';

// 统一子进程执行器：src 内 execFile / execFileSync 的唯一合法调用点（spawn.js 豁免 spawn）。
// 选项固定：timeout、killSignal=SIGKILL（SIGTERM 对挂起进程可能无效）、windowsHide（不弹黑框）、显式 maxBuffer（Node 默认 1MB 会误判冗长输出）；
//   run()/runOut() 失败或超时返回 null。同步版仅限守卫启动早期与 CLI 一次性命令，事件循环敏感路径必须 runOutAsync/runAsync（同步会冻结整个 tick）。

const { execFileSync, execFile } = require('node:child_process');

const DEFAULT_TIMEOUT_MS = 15000;

/** 默认输出上限（8MB）：足以容纳 systemctl status / ip route 等冗长输出。 */
const DEFAULT_MAX_BUFFER = 8 * 1024 * 1024;

/** 把调用参数规范化为 execFileSync 选项，保证 timeout 与 killSignal 一定存在。 */
function options(opts) {
  const o = opts || {};
  return {
    timeout: o.timeoutMs || DEFAULT_TIMEOUT_MS,
    // 必须 SIGKILL：SIGTERM 对挂起或被停住的进程可能无效。
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

/** 有界执行：失败或超时返回 null（调用方自行降级）。 */
function run(bin, args, opts) {
  const o = opts || {};
  try {
    const out = execFileSync(bin, args, options(o));
    // execFileSync 在未捕获 stdout 时命令成功也返回 null。本函数对外契约是失败/超时返回 null，
    // 故成功一律返回非 null（无 stdout 时给空 Buffer 或空串），否则调用方会把成功读成失败。
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

/** 同 run，返回 stdout 字符串（失败或超时返回 null）。 */
function runOut(bin, args, opts) {
  const o = Object.assign({}, opts || {}, { encoding: 'utf8' });
  const r = run(bin, args, o);
  if (r === null) return null;
  try { return String(r); } catch { return null; }
}

/** 异步有界执行（runDetail 的异步同族，绝不 reject）：有界纪律与同步版同一套（options()）。
 *  需区分「命令失败」与「超时」的调用方用它。 */
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
    // execFile 对不可执行文件（如 Windows .cmd 的 EINVAL 缓解）会同步抛出——
    //   必须并进失败结果，否则「绝不 reject」契约被打破（同步版 run() 的 catch 同语义）。
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

/** 异步有界执行，返回 stdout 字符串 Promise（失败/超时 resolve(null)，绝不 reject）。 */
function runOutAsync(bin, args, opts) {
  return runAsync(bin, args, opts).then((r) => (r.ok ? r.stdout : null));
}

/** 同 run，但返回结构化结果且不吞错误信息；用于区分命令失败与超时（二者对用户含义不同）。 */
function runDetail(bin, args, opts) {
  const o = opts || {};
  try {
    const out = execFileSync(bin, args, options(Object.assign({}, o, { encoding: 'utf8' })));
    return { ok: true, code: '0', stdout: String(out || ''), stderr: '', timedOut: false, error: null };
  } catch (e) {
    // Node 超时错误：message 含 ETIMEDOUT，或被信号杀死时 signal 有值。
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
