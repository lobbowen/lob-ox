'use strict';

// Windows 注册表只读查询的原语层：reg.exe 的输出排版、%VAR% 不展开、回显根名已展开这三件事只在这里认一次。
//   浏览器探测（./browser-inventory.js）与出网条件（./egress.js）都从这里取用：同一个 `reg query` 结果
//   若各自解析，就会出现「一边认 REG_EXPAND_SZ、另一边不认」这种在真机上无从对质的分叉。
// 本文件不 spawn：runner 由调用方交进来（超时口径与测试注入缝都留在调用方）。

/** reg.exe 的字符串值行排版：`/ve` 取默认值、`/v Name` 取具名值，两者同为「名字 类型 数据」。
 *  REG_EXPAND_SZ 必须一起认：安装器写下的 open\command 与代理地址常是 %VAR% 这类待展开形态，
 *  只匹配 REG_SZ 等于把这类注册当成「没注册」—— 静默漏检。 */
function regValueOf(out) {
  const m = String(out || '').match(/REG_(?:EXPAND_SZ|SZ)\s+(.*)/);
  if (!m) return null;
  return m[1].trim() || null;
}

/** DWORD 值（0/1 开关类）：与字符串值是两种排版，混为一谈会把 ProxyEnable=0 读成「没配」。
 *  非 DWORD 一律 null —— 不拿同名字符串值凑数。`0x` 前缀是 reg.exe 的实际排版，按十六进制读。 */
function regDwordOf(out) {
  const m = String(out || '').match(/REG_DWORD\s+(0x[0-9a-fA-F]+|\d+)\b/);
  if (!m) return null;
  const n = Number.parseInt(m[1], m[1].startsWith('0x') ? 16 : 10);
  return Number.isNaN(n) ? null : n;
}

/** %VAR% 展开：reg.exe 不做展开，交回我们手里时必须自己扩（未知变量原样留着，宁可判不可用也不猜）。 */
function expandEnvVars(value, env) {
  const e = env || process.env;
  return String(value).replace(/%([^%]+)%/g, (all, name) => (e[name] === undefined ? all : e[name]));
}

/** ProgID 与键名会进 reg 的 argv（不经 shell），仍限可打印 ASCII 防控制序列；`\\` 是合法键分隔。 */
function safeRegKeyPart(s) {
  return typeof s === 'string' && s.length > 0 && s.length <= 200 && /^[\x20-\x7e]+$/.test(s) && !/[;|&`$()<>^"'\r\n]/.test(s);
}

/** `reg query` 输出的行首是**展开后的完整根名**（问 HKLM 回 HKEY_LOCAL_MACHINE），所以拿简写键去前缀比对
 *  会一行都匹配不上 —— 真机上表现为「目录里一个条目都没探到」。先归一再比。 */
const REG_HIVE_ALIAS = { HKLM: 'HKEY_LOCAL_MACHINE', HKCU: 'HKEY_CURRENT_USER', HKCR: 'HKEY_CLASSES_ROOT', HKU: 'HKEY_USERS', HKCC: 'HKEY_CURRENT_CONFIG' };
function regKeyFull(key) {
  const s = String(key || '');
  const i = s.indexOf('\\');
  const root = i < 0 ? s : s.slice(0, i);
  return (REG_HIVE_ALIAS[root.toUpperCase()] || root) + (i < 0 ? '' : s.slice(i));
}

/** 一个注册表键的默认值或具名值（只读；失败返回 null 并记一条留痕）。 */
function regValue(runner, note, key, name) {
  const args = name ? ['query', key, '/v', name] : ['query', key, '/ve'];
  const out = runner('reg.exe', args);
  const v = regValueOf(out);
  note(name ? key + ' /v ' + name : key, v ? 'ok' : 'empty');
  return v;
}

/** 键下子键名列表（`reg query <key>` 不带 /v 时逐行打印完整子键路径）。 */
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

/** RegisteredApplications 的值数据 = 能力键路径（相对其根），逐个返回可直接再查的绝对键路径。 */
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
