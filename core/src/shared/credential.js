'use strict';

// R3 / 攻击链 C：下限从 8 位提到 16 位。
// relay 的 gateLedger 背压是 10 次失败锁 60s，60s 后可再试 10 次，即每小时 600 次
// 尝试，且按 IP 记但不持久化（换 IP 即重置）。8 位令牌在这个窗口下可被持续爆破。
// 16 位把可行窗口压到实际不可行（配合 D.11-E-5 的指数锁定更稳）。
// 注意：这是**校验下限**，不影响已有令牌；已有不足 16 位的令牌在下次设置时会被拒。
const MIN_TOKEN_LEN = 16;

function remoteTokenStrength(token) {
  const t = String(token == null ? '' : token).trim();
  if (!t) return { ok: false, reason: 'empty' };
  if (t.length < MIN_TOKEN_LEN) return { ok: false, reason: 'short' };
  return { ok: true, reason: '' };
}

module.exports = { remoteTokenStrength, MIN_TOKEN_LEN };
