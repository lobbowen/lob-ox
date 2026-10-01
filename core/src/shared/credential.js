'use strict';

function remoteTokenStrength(token) {
  const t = String(token == null ? '' : token).trim();
  if (!t) return { ok: false, reason: 'empty' };
  if (t.length < 8) return { ok: false, reason: 'short' };
  return { ok: true, reason: '' };
}

module.exports = { remoteTokenStrength };
