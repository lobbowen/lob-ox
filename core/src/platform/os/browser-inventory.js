'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const exec = require('../util/exec');
const { isExecutableFile } = require('./exec-path');
const registry = require('./registry');
const { expandEnvVars, safeRegKeyPart, regValue, regSubkeys, regValueTargets } = registry;

const PROBE_TIMEOUT_MS = 1500;

function engineOf(bin) {
  const base = String(bin || '').toLowerCase().split(/[\\/]/).pop();
  if (/(chrome|chromium|msedge|edge|brave|vivaldi|opera|thorium)/.test(base)) return 'chromium';
  if (/(firefox|librewolf|waterfox)/.test(base)) return 'firefox';
  return 'other';
}

function tokenizeExec(line) {
  const toks = [];
  let cur = ''; let q = null; let esc = false; let has = false;
  for (const ch of String(line)) {
    if (esc) { cur += ch; esc = false; continue; }
    if (ch === '\\') { esc = true; has = true; continue; }
    if (q) { if (ch === q) q = null; else cur += ch; continue; }
    if (ch === "'" || ch === '"') { q = ch; has = true; continue; }
    if (/\s/.test(ch)) { if (has) { toks.push(cur); cur = ''; has = false; } continue; }
    cur += ch; has = true;
  }
  if (has) toks.push(cur);
  return toks;
}

function parseExecLine(line) {
  let toks = tokenizeExec(line).filter((t) => t !== '%%' && !/^%[a-zA-Z]$/.test(t));
  if (toks[0] === 'env') {
    let i = 1;
    while (i < toks.length && /=/.test(toks[i])) i++;
    toks = toks.slice(i);
  }
  if (!toks.length) return null;
  return { bin: toks[0], baseArgs: toks.slice(1) };
}

function exeFromCmdLine(cmdLine) {
  const s = String(cmdLine || '');
  let m = s.match(/^\s*"([^"]+\.exe)"/i);
  if (m) return m[1];
  m = s.match(/^\s*(.*?\.exe)/i);
  return m ? m[1] : null;
}

const WIN_APP_PATHS = ['msedge.exe', 'chrome.exe', 'firefox.exe', 'brave.exe', 'opera.exe', 'vivaldi.exe', 'chromium.exe', 'thorium.exe', 'librewolf.exe'];

function winExeOfProgId(runner, note, progId, env) {
  if (!safeRegKeyPart(progId)) return null;
  for (const root of ['HKCU\\Software\\Classes', 'HKLM\\Software\\Classes']) {
    const cmd = regValue(runner, note, root + '\\' + progId + '\\shell\\open\\command');
    const exe = cmd ? exeFromCmdLine(expandEnvVars(cmd, env)) : null;
    if (exe) return exe;
  }
  return null;
}

function probeWin(d) {
  const { runOut, env, canExec } = d;
  const notes = [];
  const note = (source, detail) => { notes.push({ source, detail }); };
  const found = new Map();
  const keyOf = (exe) => String(exe || '').toLowerCase().replace(/[\\/]/g, '\\');
  const push = (exe, how) => {
    const full = expandEnvVars(exe, env).trim();
    if (!/\.exe$/i.test(full)) { note(how, '来源给出的不是 exe 路径: ' + full); return null; }
    const k = keyOf(full);
    const hit = found.get(k);
    if (hit) { if (!hit.sources.includes(how)) hit.sources.push(how); return hit; }
    if (!canExec(full)) { note(how, '指向的文件不可执行: ' + full); return null; }
    const item = { id: k, name: path.basename(full).replace(/\.exe$/i, ''), engine: engineOf(full), bin: full, source: how, sources: [how] };
    found.set(k, item);
    note(how, item.name);
    return item;
  };
  const progIds = new Map();
  const addProgId = (pid, how) => {
    const s = String(pid || '').trim();
    if (!safeRegKeyPart(s)) return;
    if (progIds.get(s) === 'userchoice') return;
    progIds.set(s, how);
  };
  let defaultId = null;
  let defaultSource = null;
  const DEF_RANK = { userchoice: 1, 'scheme-association': 2, 'only-installed': 9 };
  let defRank = 99;
  const setDefault = (item, how) => {
    const r = DEF_RANK[how] === undefined ? 99 : DEF_RANK[how];
    if (item && r < defRank) { defRank = r; defaultId = item.id; defaultSource = how; }
  };

  const cmdToExe = (raw) => (raw ? exeFromCmdLine(expandEnvVars(raw, env)) : null);

  const uc = regValue(runOut, note, 'HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice', 'ProgId');
  if (uc) addProgId(uc, 'userchoice');
  for (const root of ['HKCU\\Software\\Classes', 'HKLM\\Software\\Classes']) {
    const pid = regValue(runOut, note, root + '\\https');
    if (pid) addProgId(pid, 'scheme-association');
    const exe = cmdToExe(regValue(runOut, note, root + '\\https\\shell\\open\\command'));
    if (exe) setDefault(push(exe, 'scheme-association'), 'scheme-association');
  }
  for (const name of regSubkeys(runOut, note, 'HKLM\\SOFTWARE\\Clients\\StartMenuInternet')) {
    addProgId(name, 'startmenu-catalog');
    const exe = cmdToExe(regValue(runOut, note, 'HKLM\\SOFTWARE\\Clients\\StartMenuInternet\\' + name + '\\shell\\open\\command'))
      || winExeOfProgId(runOut, note, name, env);
    if (exe) push(exe, 'startmenu-catalog');
  }
  for (const root of ['HKLM\\SOFTWARE', 'HKCU\\SOFTWARE']) {
    for (const capPath of regValueTargets(runOut, note, root + '\\RegisteredApplications')) {
      const https = regValue(runOut, note, capPath + '\\UrlAssociations\\https');
      const sid = regValue(runOut, note, capPath, 'StartMenuInternet');
      const pid = https || sid;
      if (pid) addProgId(pid, 'registered-apps');
    }
  }
  for (const exe of WIN_APP_PATHS) {
    for (const root of ['HKCU', 'HKLM']) {
      const v = regValue(runOut, note, root + '\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\' + exe);
      if (v && push(v, 'app-paths')) break;
    }
  }
  for (const [pid, how] of progIds) {
    const exe = winExeOfProgId(runOut, note, pid, env);
    if (!exe) continue;
    const item = push(exe, how);
    if (how === 'userchoice') setDefault(item, 'userchoice');
  }
  if (found.size === 1) setDefault([...found.values()][0], 'only-installed');
  return { browsers: [...found.values()], defaultId, defaultSource, probed: notes };
}

const MAC_JXA_LIST = [
  "ObjC.import('Foundation');",
  "var ws=$.NSWorkspace.sharedWorkspace;",
  "var u=$.NSURL.URLWithString('https://dsh.local/probe');",
  "var out=[];var def='';",
  "try{var d=ws.URLForApplicationToOpenURL(u); if(!d.isNil()) def=ObjC.unwrap(d.path)||'';}catch(e){}",
  "var list=null;",
  "try{list=ws.urlsForApplicationsToOpenURL(u);}catch(e){}",
  "if(list===null||typeof list.count!=='number'){if(def){out.push(def+'\\t\\t1');}}else{",
  "var n=Number(list.count);",
  "for(var i=0;i<n;i++){",
  "var p=ObjC.unwrap(list.objectAtIndex(i).path)||''; if(!p) continue;",
  "var exe='';var bid='';",
  "var b=$.NSBundle.bundleWithPath(p);",
  "if(!b.isNil()){exe=ObjC.unwrap(b.executablePath)||'';bid=ObjC.unwrap(b.bundleIdentifier)||'';}",
  "out.push((exe||p)+'\\t'+bid+'\\t'+(p&&def&&p===def?1:0));}",
  "}",
  "out.join('\\n');",
].join('');

function probeMac(d) {
  const { runOut, canExec } = d;
  const notes = [];
  const note = (source, detail) => { notes.push({ source, detail }); };
  const out = runOut('osascript', ['-l', 'JavaScript', '-e', MAC_JXA_LIST]);
  if (!out || !out.trim()) { note('launchservices', '查询无输出（旧系统或被权限拦截）'); return { browsers: [], defaultId: null, defaultSource: null, probed: notes }; }
  const keyOf = (exe) => String(exe || '').toLowerCase();
  const found = new Map();
  let defaultId = null;
  let defaultSource = null;
  for (const line of out.trim().split('\n')) {
    const parts = line.split('\t');
    const bin = (parts[0] || '').trim();
    if (!bin) continue;
    if (!canExec(bin)) { note('launchservices', '不可执行: ' + bin); continue; }
    const k = keyOf(bin);
    if (!found.has(k)) found.set(k, { id: k, name: path.basename(bin), engine: engineOf(bin), bin, source: 'launchservices', sources: ['launchservices'], isDefault: false });
    if (parts[2] === '1') { found.get(k).isDefault = true; if (!defaultId) { defaultId = k; defaultSource = 'launchservices'; } }
  }
  note('launchservices', found.size ? found.size + ' 个可打开 https 的应用' : '系统未报任何可用应用');
  if (!defaultId && found.size === 1) { defaultId = [...found.keys()][0]; defaultSource = 'only-installed'; }
  return { browsers: [...found.values()], defaultId, defaultSource, probed: notes };
}

const PJ = path.posix.join;

function desktopDirs(env, home) {
  const dataHome = env.XDG_DATA_HOME || PJ(home, '.local', 'share');
  const dataDirs = String(env.XDG_DATA_DIRS || '/usr/local/share:/usr/share').split(':').filter(Boolean);
  const dirs = [[dataHome, 'xdg'], ...dataDirs.map((p) => [p, 'xdg'])];
  dirs.push([PJ(home, '.local', 'share'), 'xdg']);
  dirs.push(['/var/lib/flatpak/exports/share', 'flatpak']);
  dirs.push([PJ(home, '.local', 'share', 'flatpak', 'exports', 'share'), 'flatpak']);
  dirs.push(['/var/lib/snapd/desktop', 'snap']);
  const seen = [];
  return dirs.map(([root, kind]) => ({ dir: PJ(root, 'applications'), kind })).filter((x) => {
    if (seen.includes(x.dir)) return false;
    seen.push(x.dir);
    return true;
  });
}

function browserFromDesktop(text, kind, file) {
  let inMain = false;
  const got = {};
  for (const line of String(text).split(/\r?\n/)) {
    if (/^\[Desktop Entry\]\s*$/.test(line)) { inMain = true; continue; }
    if (/^\[/.test(line)) break;
    if (!inMain) continue;
    const m = line.match(/^(Exec|Name|TryExec|Categories)=(.*)$/);
    if (!m) continue;
    if (m[1] === 'Name' && got.Name) continue;
    got[m[1]] = m[2].trim();
  }
  if (!got.Exec) return null;
  const categories = String(got.Categories || '');
  const parsed = parseExecLine(got.Exec);
  if (!parsed) return null;
  const engine = engineOf(parsed.bin);
  const claimsBrowser = /(^|;)WebBrowser(;|$)/.test(categories);
  if (!claimsBrowser && engine === 'other') return null;
  if (engine === 'other') return null;
  return {
    id: parsed.bin.toLowerCase(),
    name: (got.Name || path.basename(file, '.desktop')),
    engine, bin: parsed.bin, baseArgs: parsed.baseArgs, source: kind, desktopFile: file,
  };
}

function resolveLinuxBin(bin, canExec, env) {
  const b = String(bin || '').trim();
  if (!b) return null;
  if (b.startsWith('/')) return canExec(b) ? b : null;
  if (b.includes('/')) return null;
  for (const dir of String(env.PATH || '').split(':')) {
    if (!dir) continue;
    const p = PJ(dir.replace(/\/+$/, ''), b);
    if (canExec(p)) return p;
  }
  return null;
}

function probeLinux(d) {
  const { runOut, readFile, exists, listDir, canExec, env, home } = d;
  const notes = [];
  const note = (source, detail) => { notes.push({ source, detail }); };
  const found = new Map();
  const usable = (item) => {
    const resolved = resolveLinuxBin(item.bin, canExec, env);
    if (!resolved) { note(item.source, '不可执行: ' + item.bin); return null; }
    const k = resolved.toLowerCase();
    const hit = found.get(k);
    if (hit) { if (!hit.sources.includes(item.source)) hit.sources.push(item.source); return hit; }
    const v = Object.assign({}, item, { id: k, bin: resolved, sources: [item.source] });
    found.set(k, v);
    return v;
  };
  for (const { dir, kind } of desktopDirs(env, home)) {
    let names = [];
    try { names = listDir(dir).filter((f) => f.endsWith('.desktop')); } catch { continue; }
    for (const f of names) {
      let text = null;
      try { text = readFile(PJ(dir, f)); } catch { continue; }
      const item = browserFromDesktop(text, kind, f);
      if (item) usable(item);
    }
  }
  let defaultId = null;
  let defaultSource = null;
  const fromMime = linuxDefaultFromMimeApps(readFile, exists, env, home, note);
  if (fromMime) { const item = usable(fromMime); if (item) { defaultId = item.id; defaultSource = 'mimeapps'; } }
  const id = runOut('xdg-settings', ['get', 'default-web-browser']);
  const desktopId = id && String(id).trim();
  if (!defaultId && desktopId && /^[A-Za-z0-9._-]+\.desktop$/.test(desktopId)) {
    for (const { dir } of desktopDirs(env, home)) {
      const p = PJ(dir, desktopId);
      let text = null;
      try { if (exists(p)) text = readFile(p); } catch { continue; }
      if (text === null) continue;
      const item = browserFromDesktop(text, 'xdg-settings', desktopId);
      const used = item && usable(item);
      if (used) { defaultId = used.id; defaultSource = 'xdg-settings'; break; }
    }
  }
  if (!desktopId) note('xdg-settings', '无输出');
  else if (defaultSource === 'xdg-settings') note('xdg-settings', '默认=' + defaultId);
  else note('xdg-settings', '报出 ' + desktopId + (defaultId ? '（默认已由 ' + defaultSource + ' 定出）' : ' 但不可用'));
  if (!defaultId && found.size === 1) { defaultId = [...found.keys()][0]; defaultSource = 'only-installed'; }
  return { browsers: [...found.values()], defaultId, defaultSource, probed: notes };
}

function linuxDefaultFromMimeApps(readFile, exists, env, home, note) {
  const cfgHome = env.XDG_CONFIG_HOME || PJ(home, '.config');
  const cfgDirs = String(env.XDG_CONFIG_DIRS || '/etc/xdg').split(':').filter(Boolean);
  const dataDirs = String(env.XDG_DATA_DIRS || '/usr/local/share:/usr/share').split(':').filter(Boolean);
  const files = [PJ(cfgHome, 'mimeapps.list'), ...cfgDirs.map((d) => PJ(d, 'mimeapps.list')),
    ...dataDirs.map((d) => PJ(d, 'applications', 'mimeapps.list'))];
  for (const f of files) {
    if (!exists(f)) continue;
    let text = null;
    try { text = readFile(f); } catch { continue; }
    const id = mimeAppsDefault(text);
    if (!id) continue;
    note('mimeapps', path.basename(f) + ' -> ' + id);
    for (const { dir, kind } of desktopDirs(env, home)) {
      const p = PJ(dir, id);
      if (!exists(p)) continue;
      let dt = null;
      try { dt = readFile(p); } catch { continue; }
      const item = browserFromDesktop(dt, kind, id);
      if (item) return item;
    }
    return null;
  }
  note('mimeapps', '无默认项');
  return null;
}

function mimeAppsDefault(text) {
  let inDefault = false;
  for (const line of String(text || '').split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) { inDefault = /^\s*\[Default Applications\]\s*$/.test(line); continue; }
    if (!inDefault) continue;
    const m = line.match(/^\s*x-scheme-handler\/https?\s*=\s*(.*)$/i);
    if (!m) continue;
    const ids = m[1].split(';').map((s) => s.trim()).filter((s) => /^[A-Za-z0-9._-]+\.desktop$/.test(s));
    if (ids.length) return ids[0];
  }
  return null;
}

function probe(platform, d) {
  const pl = platform || process.platform;
  const dd = Object.assign({}, d, { canExec: d.canExec || ((p) => isExecutableFile(p, pl)) });
  if (pl === 'win32') return probeWin(dd);
  if (pl === 'darwin') return probeMac(dd);
  return probeLinux(dd);
}

const CACHE = Object.create(null);

function inventory(platform, o) {
  const ov = o || {};
  const pl = platform || process.platform;
  const now = ov.now || (() => Date.now());
  const ttl = ov.ttlMs === undefined ? 60000 : ov.ttlMs;
  const cached = CACHE[pl];
  if (!ov.force && cached && now() - cached.at < ttl) return Object.assign({ cached: true }, cached.value);
  const runOut = ov.runOut || ((bin, args) => exec.runOut(bin, args, { timeoutMs: PROBE_TIMEOUT_MS }));
  const readFile = ov.readFile || ((p) => fs.readFileSync(p, 'utf8'));
  const exists = ov.exists || ((p) => fs.existsSync(p));
  const listDir = ov.listDir || ((p) => fs.readdirSync(p));
  let value;
  try {
    value = probe(pl, { runOut, readFile, exists, listDir, canExec: ov.canExec, env: ov.env || process.env, home: ov.home || os.homedir() });
  } catch (e) {
    value = { browsers: [], defaultId: null, defaultSource: null, probed: [{ source: 'probe-error', detail: String((e && e.message) || e) }] };
  }
  value.at = now();
  value.platform = pl;
  value.browsers.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  CACHE[pl] = { at: now(), value };
  return Object.assign({ cached: false }, value);
}

function invalidate(platform) {
  if (platform) delete CACHE[platform];
  else for (const k of Object.keys(CACHE)) delete CACHE[k];
}

module.exports = {
  inventory, invalidate, probe, probeWin, probeMac, probeLinux,
  engineOf, tokenizeExec, parseExecLine, exeFromCmdLine,
  regValueOf: registry.regValueOf, expandEnvVars, safeRegKeyPart, regKeyFull: registry.regKeyFull,
  regValue, regSubkeys, regValueTargets,
  browserFromDesktop, desktopDirs, resolveLinuxBin, mimeAppsDefault, linuxDefaultFromMimeApps,
  WIN_APP_PATHS, PROBE_TIMEOUT_MS,
};
