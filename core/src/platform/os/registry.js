'use strict';

// reg.exe 的排版、%VAR% 不展开、根名已展开三件事只在此认一次（浏览器探测与出网条件共用，各自解析必然分叉）。

function regValueOf(out) {
  const m = String(out || '').match(/REG_(?:EXPAND_SZ|SZ)\s+(.*)/);
  if (!m) return null;
  return m[1].trim() || null;
}

function regDwordOf(out) {
  const m = String(out || '').match(/REG_DWORD\s+(0x[0-9a-fA-F]+|\d+)\b/);
  if (!m) return null;
  const n = Number.parseInt(m[1], m[1].startsWith('0x') ? 16 : 10);
  return Number.isNaN(n) ? null : n;
}

function expandEnvVars(value, env) {
  const e = env || process.env;
  return String(value).replace(/%([^%]+)%/g, (all, name) => (e[name] === undefined ? all : e[name]));
}

function safeRegKeyPart(s) {
  return typeof s === 'string' && s.length > 0 && s.length <= 200 && /^[\x20-\x7e]+$/.test(s) && !/[;|&`$()<>^"'\r\n]/.test(s);
}

const REG_HIVE_ALIAS = { HKLM: 'HKEY_LOCAL_MACHINE', HKCU: 'HKEY_CURRENT_USER', HKCR: 'HKEY_CLASSES_ROOT', HKU: 'HKEY_USERS', HKCC: 'HKEY_CURRENT_CONFIG' };
function regKeyFull(key) {
  const s = String(key || '');
  const i = s.indexOf('\\');
  const root = i < 0 ? s : s.slice(0, i);
  return (REG_HIVE_ALIAS[root.toUpperCase()] || root) + (i < 0 ? '' : s.slice(i));
}

function regValue(runner, note, key, name) {
  const args = name ? ['query', key, '/v', name] : ['query', key, '/ve'];
  const out = runner('reg.exe', args);
  const v = regValueOf(out);
  note(name ? key + ' /v ' + name : key, v ? 'ok' : 'empty');
  return v;
}

function regSubkeys(runner, note, key) {
  const out = runner('reg.exe', ['query', key]);
  if (!out) { note(key, 'unreadable'); return []; }
  const prefix = regKeyFull(key) + '\\';
  const names = [];
  for (const line of String(out).split(/\r?\n/)) {
    const l = line.trim();
    if (!/^HKEY_/i.test(l) || l.length <= prefix.length) continue;
    if (l.slice(0, prefix.length).toUpperCase() !== prefix.toUpperCase()) continue;
    const rest = l.slice(prefix.length);
    if (rest && !rest.includes('\\') && safeRegKeyPart(rest)) names.push(rest);
  }
  note(key, names.length ? names.length + ' 项' : '无子键');
  return names;
}

function regValueTargets(runner, note, key) {
  const out = runner('reg.exe', ['query', key]);
  if (!out) { note(key, 'unreadable'); return []; }
  const paths = [];
  for (const line of String(out).split(/\r?\n/)) {
    const m = line.trim().match(/REG_SZ\s+(.*)/);
    if (!m) continue;
    const rel = m[1].trim();
    if (!safeRegKeyPart(rel)) continue;
    const root = key.slice(0, key.indexOf('\\'));
    paths.push(root + '\\' + rel);
  }
  note(key, paths.length ? paths.length + ' 个能力路径' : '无值');
  return paths;
}

module.exports = {
  regValueOf, regDwordOf, expandEnvVars, safeRegKeyPart,
  REG_HIVE_ALIAS, regKeyFull, regValue, regSubkeys, regValueTargets,
};
