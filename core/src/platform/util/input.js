'use strict';

const PKG_NAME_RE = /^(@[a-zA-Z0-9._-]+\/)?[a-zA-Z0-9._-]+$/;

const ARGV_UNSAFE_RE = /[\s;|&<>`'"$(){}\\*?~#]/;

const WIN_ABS_PATH_RE = /^[A-Za-z]:\\[^;|&<>`'"$*?~#\s]*$/;

const UNIT_NAME_RE = /^[A-Za-z0-9:@._-]{1,128}$/;

const UNSAFE_LEDGER_KEYS = ['__proto__', 'prototype', 'constructor'];

const LEDGER_UNSAFE_RE = /[\s\u0000-\u001f\u007f]/;

function argvViolation(arg) {
  const s = String(arg == null ? '' : arg);
  if (!s) return '空的 argv 项';
  if (ARGV_UNSAFE_RE.test(s) && !WIN_ABS_PATH_RE.test(s)) return 'argv 项含禁用字符（空白/shell 元字符）: ' + s.slice(0, 80);
  return null;
}

const CONTROL_RE = /[\u0000-\u001f\u007f]/;

function isAbsoluteForm(p) {
  const s = String(p == null ? '' : p);
  return s.charCodeAt(0) === 47
    || /^[A-Za-z]:[\\/]/.test(s)
    || (s.charCodeAt(0) === 92  && s.charCodeAt(1) === 92);
}

function prefixViolation(prefix) {
  const s = String(prefix == null ? '' : prefix);
  if (!s.trim()) return '空的安装前缀';
  if (CONTROL_RE.test(s)) return '安装前缀含控制符: ' + s.slice(0, 80);
  if (s.length > 4096) return '安装前缀超长: ' + s.slice(0, 60) + '...';
  if (s[0] === '-') return '安装前缀以 - 开头（会被当作 npm 选项）: ' + s.slice(0, 80);
  if (!isAbsoluteForm(s)) return '安装前缀须为绝对路径（/ 开头、win 盘符或 UNC）: ' + s.slice(0, 80);
  return null;
}

function pkgNameViolation(pkg) {
  const s = String(pkg == null ? '' : pkg);
  return PKG_NAME_RE.test(s) ? null : '非法包名（字符集白名单不通过）: ' + s.slice(0, 80);
}

function unitNameViolation(unit) {
  const s = String(unit == null ? '' : unit);
  if (!UNIT_NAME_RE.test(s)) return '非法单元名（字符集/长度白名单不通过）: ' + s.slice(0, 80);
  const dot = s.indexOf('.');
  if (dot >= 0 && !/\.service$/.test(s)) return '单元名后缀不受支持（仅允许 .service 或无后缀）: ' + s.slice(0, 80);
  return null;
}

function ledgerKey(raw, opts) {
  const o = opts || {};
  const max = typeof o.max === 'number' ? o.max : 128;
  const empty = o.empty == null ? 'unknown' : o.empty;
  const unsafe = o.unsafe == null ? '(other)' : o.unsafe;
  if (typeof raw !== 'string' || !raw) return empty;
  const s = raw.length > max ? raw.slice(0, max) : raw;
  if (UNSAFE_LEDGER_KEYS.indexOf(s) >= 0 || LEDGER_UNSAFE_RE.test(s)) return unsafe;
  return s;
}

module.exports = {
  PKG_NAME_RE, ARGV_UNSAFE_RE, WIN_ABS_PATH_RE, UNIT_NAME_RE,
  UNSAFE_LEDGER_KEYS, LEDGER_UNSAFE_KEYS_RE: LEDGER_UNSAFE_RE,
  argvViolation, pkgNameViolation, unitNameViolation, ledgerKey,
  CONTROL_RE, isAbsoluteForm, prefixViolation,
};
