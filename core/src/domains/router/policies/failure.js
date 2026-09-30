'use strict';

// S2 失败反应纯策略：零 require / 零 this / 零 IO。
// headerRetryMs/bodyResetMs 与 providers/policies/quota.js 的同名解析有意平行（纯策略不得
// 反向依赖 provider 文件；quota 版 ISO 走 normalizeResetTs 多兼容 epoch 数字）——改词表时两处一并核对。

/** Retry-After / x-ratelimit-reset-ms -> 剩余 ms（0=未知）。 */
function headerRetryMs(headers) {
  const h = headers || {};
  const ep = h['x-ratelimit-reset-ms'];
  if (ep !== undefined && String(ep).trim() !== '') {
    const n = parseInt(String(ep), 10);
    if (Number.isFinite(n) && n > 0) return Math.max(0, n - Date.now());
  }
  const raw = String(h['retry-after'] || '').trim();
  if (!raw) return 0;
  const n = parseInt(raw, 10);
  if (Number.isFinite(n) && n > 0) return n * 1000;
  const at = Date.parse(raw);
  return Number.isFinite(at) && at > Date.now() ? at - Date.now() : 0;
}

/** 响应体 "resets in N min" / "resets at <ISO>" -> 剩余 ms（0=未知）。 */
function bodyResetMs(text) {
  const t = String(text || '');
  const m = /(?:resets?|retry|try again|after|available)\s+in\s+(\d+)\s*(min|sec|second|s|hour|hr)?/.exec(t.toLowerCase());
  if (m) {
    const n = parseInt(m[1], 10);
    if (Number.isFinite(n) && n > 0) {
      const u = m[2] || '';
      return u.startsWith('min') ? n * 60000 : (u.startsWith('hour') || u.startsWith('hr')) ? n * 3600000 : n * 1000;
    }
  }
  const iso = /(\d{4}-\d{2}-\d{2}[T ][0-9:.]+(?:Z|[+-]\d{2}:?\d{2})?)/.exec(t);
  if (!iso) return 0;
  const at = Date.parse(iso[1]);
  return Number.isFinite(at) && at > Date.now() ? at - Date.now() : 0;
}

/** S2：失败信号 -> 处置动作（唯一纯判定）。ctx = { status, headers, body, key }。
 *  credits|window -> retry（needEffect）；banned -> passthrough（needEffect）；
 *  transient -> retry+transient（不施加 effect）；none/unknown -> passthrough（绝不误切，INV-1）。 */
function decideFailure(signal, ctx) {
  const c = ctx || {};
  const key = c.key || '?';
  const status = c.status;
  const body = String(c.body || '');
  if (signal === 'credits' || signal === 'window') {
    return {
      action: 'retry', signal, needEffect: true,
      retryMs: signal === 'window' ? (headerRetryMs(c.headers) || bodyResetMs(body)) : 0,
      info: (signal === 'credits' ? 'CREDITS-EXHAUSTED key=' : 'QUOTA-EXHAUSTED key=') + key,
    };
  }
  if (signal === 'banned') return { action: 'passthrough', signal, needEffect: true, status, headers: c.headers, body, log: 'BANNED key=' + key };
  if (signal === 'transient') return { action: 'retry', signal, needEffect: false, transient: true, log: 'TRANSIENT key=' + key + ' status=' + status };
  return { action: 'passthrough', signal, needEffect: false, status, headers: c.headers, body };
}

module.exports = { decideFailure, headerRetryMs, bodyResetMs };
