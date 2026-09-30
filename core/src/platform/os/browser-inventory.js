'use strict';

// 系统浏览器探测层：只回答「这台机器装了哪些浏览器、默认是哪个、每条结论是从哪个系统事实读来的」，
//   不 launch、不猜命令、不在查不到时替用户挑一个试试（选路与执行在 ./browser.js，那是外部打开唯一出口）。
//
// 为什么必须有这一层：旧实现只问「默认浏览器是谁」，且只问一句（Win7 起被系统忽略的 StartMenuInternet
//   默认值），问不到就退到系统 shell 冒开 —— 真机结果就是「面板说交出去了，屏幕上什么都没有」。
//   所以本层的硬要求是：多源并集 + 每条来源都留痕。probed 会原样抵达面板，下次真机不用读代码就能定性。

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const exec = require('../util/exec');
const { isExecutableFile } = require('./exec-path');
// 注册表解析原语的唯一实现住在 ./registry.js：本层不复制一份 reg.exe 排版解析。浏览器探测与出网条件
//   问的是同一张注册表，两处各写一遍必然分叉（一边认 REG_EXPAND_SZ、另一边不认就是静默漏检）。
const registry = require('./registry');
const { expandEnvVars, safeRegKeyPart, regValue, regSubkeys, regValueTargets } = registry;

/** 单条系统查询的上界：探测不得成为用户可见的失败原因，也不得吃掉面板 15s 动作预算。 */
const PROBE_TIMEOUT_MS = 1500;

/** 引擎族判定（唯一实现处）：裸 URL 直启只有这两族语义确定，other（Safari、snap 包装器）交回调度器。 */
function engineOf(bin) {
  const base = String(bin || '').toLowerCase().split(/[\\/]/).pop();
  if (/(chrome|chromium|msedge|edge|brave|vivaldi|opera|thorium)/.test(base)) return 'chromium';
  if (/(firefox|librewolf|waterfox)/.test(base)) return 'firefox';
  return 'other';
}

/** desktop 文件 Exec 行的 shell 式分词（单双引号与反斜杠转义；% 字段码剔除在 parseExecLine）。 */
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

/** Exec 行 -> {bin, baseArgs}：URL 字段码剔除、`env VAR=x bin` 包装去壳；解析不出首 token 返回 null。 */
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

/** 注册表 open\command 命令行 -> 可执行文件路径（纯函数；带引号与裸 .exe 两种形态）。
 *  未加引号时路径本身也可以带空格（注册表里的 REG_EXPAND_SZ 常这么写），所以取「第一个 .exe 截止处」，
 *  而不是首个空白 token —— 后者会把 `C:\Program Files (x86)\...\msedge.exe -- "%1"` 读成 `C:\Program`。 */
function exeFromCmdLine(cmdLine) {
  const s = String(cmdLine || '');
  let m = s.match(/^\s*"([^"]+\.exe)"/i);
  if (m) return m[1];
  m = s.match(/^\s*(.*?\.exe)/i);
  return m ? m[1] : null;
}

// win32 的 App Paths 候选：只列厂商公开安装的 exe 名（该键是文档化的安装位置，逐个查询即枚举）。
const WIN_APP_PATHS = ['msedge.exe', 'chrome.exe', 'firefox.exe', 'brave.exe', 'opera.exe', 'vivaldi.exe', 'chromium.exe', 'thorium.exe', 'librewolf.exe'];

/** ProgID -> 可执行文件：HKCU 的 Classes 优先（per-user 安装就写在这里），再 HKLM。
 *  reg.exe 不展开 %VAR%，且值是命令行而非路径，两处都得先展开再取本体。 */
function winExeOfProgId(runner, note, progId, env) {
  if (!safeRegKeyPart(progId)) return null;
  for (const root of ['HKCU\\Software\\Classes', 'HKLM\\Software\\Classes']) {
    const cmd = regValue(runner, note, root + '\\' + progId + '\\shell\\open\\command');
    const exe = cmd ? exeFromCmdLine(expandEnvVars(cmd, env)) : null;
    if (exe) return exe;
  }
  return null;
}

/** win32 探测：五条文档化来源取并集，任一条失败都不影响其余，全部留痕进 probed。
 *  - UserChoice：Win10/11 上「用户选的 https 浏览器」的实际归属；
 *  - scheme-association：HKCU/HKLM Classes\https 的 ProgID 与其 open\command，即系统真正把地址交给谁；
 *  - StartMenuInternet 子键：浏览器目录（其**默认值**自 Win7 起被系统忽略，故只当目录用，不再当默认值读）；
 *  - RegisteredApplications：应用名 -> 能力路径 -> 该应用声明的 https ProgID；
 *  - App Paths：per-user 安装的浏览器也登记在这里（HKCU 先于 HKLM）。
 *  @param {{runOut:Function, env:object, canExec:Function}} d
 *  @returns {{browsers:object[], defaultId:string|null, defaultSource:string|null, probed:object[]}} */
function probeWin(d) {
  const { runOut, env, canExec } = d;
  const notes = [];
  const note = (source, detail) => { notes.push({ source, detail }); };
  const found = new Map(); // 归一后的 exe 路径 -> 条目（大小写与分隔符不同视为同一个）
  const keyOf = (exe) => String(exe || '').toLowerCase().replace(/[\\/]/g, '\\');
  const push = (exe, how) => {
    const full = expandEnvVars(exe, env).trim();
    // 来源报了但不是本体路径（例如 App Paths 的默认值按规范写的是安装目录）：留痕而不入册，
    //   否则真机上「明明注册过却没探到」就成了无从解释的黑箱。
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
  const progIds = new Map(); // ProgID -> 来源说明（userchoice 一旦记下就不被后续来源改写）
  const addProgId = (pid, how) => {
    const s = String(pid || '').trim();
    if (!safeRegKeyPart(s)) return;
    if (progIds.get(s) === 'userchoice') return;
    progIds.set(s, how);
  };
  let defaultId = null;
  let defaultSource = null;
  // 默认项的来源有高低：用户自己选的（UserChoice）> 系统对 https 协议的关联 > 穷举唯一解。
  // 低优先级的来源晚到也不得翻案，否则「默认浏览器」又变成探测顺序的副产品。
  const DEF_RANK = { userchoice: 1, 'scheme-association': 2, 'only-installed': 9 };
  let defRank = 99;
  const setDefault = (item, how) => {
    const r = DEF_RANK[how] === undefined ? 99 : DEF_RANK[how];
    if (item && r < defRank) { defRank = r; defaultId = item.id; defaultSource = how; }
  };

  // 注册表里 open\command 的两处固有变形：reg.exe 不展开 %VAR%，值本身是命令行而非路径。
  //   任何一条来源取到的值都必须过这道手，否则「探到了却认不出」会以空清单的形式复现本轮的缺陷。
  const cmdToExe = (raw) => (raw ? exeFromCmdLine(expandEnvVars(raw, env)) : null);

  const uc = regValue(runOut, note, 'HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice', 'ProgId');
  if (uc) addProgId(uc, 'userchoice');
  // https 协议关联本体（HKCU 的 per-user 覆盖先于 HKLM）：默认值是处理该协议的 ProgID，其
  //   shell\open\command 就是资源管理器实际执行的命令行 —— 这是「系统会把这条地址交给谁」最接近
  //   事实的一条只读证据，也是「把地址丢给系统 shell 冒开」那条老路真正借的东西，只是后者从不把结局报回来。
  //   UserChoice 读不到（组策略收紧、部分新版）时，它是唯一还能定出默认项的来源。
  for (const root of ['HKCU\\Software\\Classes', 'HKLM\\Software\\Classes']) {
    const pid = regValue(runOut, note, root + '\\https');
    if (pid) addProgId(pid, 'scheme-association');
    const exe = cmdToExe(regValue(runOut, note, root + '\\https\\shell\\open\\command'));
    if (exe) setDefault(push(exe, 'scheme-association'), 'scheme-association');
  }
  // StartMenuInternet 的子键名就是 ProgID。它的 open\command 既写在目录键下（文档化位置），
  //   也常只在 Classes\<ProgID> 下有一份（per-user 安装、部分发行版），两处都认才叫枚举；
  //   只查一处等于把第二类装机形态整个漏掉，而它正是本轮第二台机器上「装了却探不到」的形状。
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
    // per-user 安装优先于机器级；同名 exe 两处都登记时取先到者，余下的由 push 去重。
    for (const root of ['HKCU', 'HKLM']) {
      const v = regValue(runOut, note, root + '\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\' + exe);
      if (v && push(v, 'app-paths')) break;
    }
  }
  for (const [pid, how] of progIds) {
    const exe = winExeOfProgId(runOut, note, pid, env);
    if (!exe) continue;
    const item = push(exe, how);
    // UserChoice 是唯一能说明「用户自己选了谁」的来源。
    if (how === 'userchoice') setDefault(item, 'userchoice');
  }
  // 只装了一个浏览器时，它必然就是 https 的归宿 —— 这不是猜默认值，是穷举后的唯一解。
  if (found.size === 1) setDefault([...found.values()][0], 'only-installed');
  return { browsers: [...found.values()], defaultId, defaultSource, probed: notes };
}

/** macOS 探测脚本：`urlsForApplicationsToOpenURL`（macOS 12+，Apple 文档化为「可打开该 URL 的全部应用，最佳匹配在前」）
 *  给清单，`URLForApplicationToOpenURL` 给默认；前者不可用（旧系统/权限拦截）时只交得出默认那一条，
 *  即回落「只问默认是谁」的老路——但清单为空与「探不到」在 probed 里必须区分得开。
 *  输出每行 `bin<TAB>bundleId<TAB>default`，由宿主侧拼成条目 —— 探测能力位不在 JS 侧猜 App 名。 */
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
  // 末句必须是裸表达式：osascript 取的是最后一条**语句**的值，if/else 语句不产结果，
  //   写在分支里会让整段查询输出空字符串（表现为「系统未报任何可用应用」）。
  "out.join('\\n');",
].join('');

/** darwin 探测：见 MAC_JXA_LIST。bundle 的 executablePath 才是真正能直启的本体。 */
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
  // 与 win/linux 同一判据：只有一个可用归宿时不必再问「默认是谁」。
  if (!defaultId && found.size === 1) { defaultId = [...found.keys()][0]; defaultSource = 'only-installed'; }
  return { browsers: [...found.values()], defaultId, defaultSource, probed: notes };
}

/** linux 探测拼出的恒是 POSIX 路径：用宿主 path.join 在 win 宿主（同一份测试四处跑）会产出反斜杠形态，
 *  导致探测结果随跑测试的机器变化。darwin 侧浏览器.js 同源问题用 path.posix 已有先例。 */
const PJ = path.posix.join;

/** linux 的 .desktop 目录：XDG 规范目录 + flatpak/snap 的导出目录（后两者是实现约定而非规范条款，来源字段会区分）。 */
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

/** 一个 .desktop 文件 -> 浏览器条目（非浏览器/解析不出返回 null）。
 *  判据取规范字段：Categories 含 WebBrowser 是声明，解析出的可执行文件属两族引擎是事实，两者都要。 */
function browserFromDesktop(text, kind, file) {
  let inMain = false;
  const got = {};
  for (const line of String(text).split(/\r?\n/)) {
    if (/^\[Desktop Entry\]\s*$/.test(line)) { inMain = true; continue; }
    if (/^\[/.test(line)) break;
    if (!inMain) continue;
    const m = line.match(/^(Exec|Name|TryExec|Categories)=(.*)$/);
    if (!m) continue;
    if (m[1] === 'Name' && got.Name) continue; // 首个 Name 是不带语言后缀的主名
    got[m[1]] = m[2].trim();
  }
  if (!got.Exec) return null;
  const categories = String(got.Categories || '');
  const parsed = parseExecLine(got.Exec);
  if (!parsed) return null;
  const engine = engineOf(parsed.bin);
  const claimsBrowser = /(^|;)WebBrowser(;|$)/.test(categories);
  if (!claimsBrowser && engine === 'other') return null;
  if (engine === 'other') return null; // 声明是浏览器但可执行文件不是两族：包装器（snap/flatpak）拒绝直启，交回调度器
  return {
    // id 恒为归一后的可执行文件路径：defaultId 靠它在清单里定位条目，三平台同一契约
    id: parsed.bin.toLowerCase(),
    name: (got.Name || path.basename(file, '.desktop')),
    engine, bin: parsed.bin, baseArgs: parsed.baseArgs, source: kind, desktopFile: file,
  };
}

/** linux 的 bin -> 绝对可执行路径 | null。裸名按 PATH 逐个目录试（':' 拆，与宿主分隔符无关：
 *  候选恒来自 .desktop，本就是 POSIX 语义）。exec-path 的 inPath 用宿主 delimiter，跨宿主测试会漂移，故不借它。 */
function resolveLinuxBin(bin, canExec, env) {
  const b = String(bin || '').trim();
  if (!b) return null;
  if (b.startsWith('/')) return canExec(b) ? b : null;
  if (b.includes('/')) return null; // 相对路径不是 PATH 查找的输入
  for (const dir of String(env.PATH || '').split(':')) {
    if (!dir) continue;
    const p = PJ(dir.replace(/\/+$/, ''), b);
    if (canExec(p)) return p;
  }
  return null;
}

/** linux 探测：默认值按 mimeapps 规范顺序（用户级先于系统级）+ xdg-settings 两问，清单靠扫 .desktop。
 *  @param {{runOut:Function, readFile:Function, exists:Function, listDir:Function, canExec:Function, env:object, home:string}} d */
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
  // xdg-settings 的留痕只说它自己报了什么：默认项若已被 mimeapps 定出，不要把功劳记到它头上。
  if (!desktopId) note('xdg-settings', '无输出');
  else if (defaultSource === 'xdg-settings') note('xdg-settings', '默认=' + defaultId);
  else note('xdg-settings', '报出 ' + desktopId + (defaultId ? '（默认已由 ' + defaultSource + ' 定出）' : ' 但不可用'));
  if (!defaultId && found.size === 1) { defaultId = [...found.keys()][0]; defaultSource = 'only-installed'; }
  return { browsers: [...found.values()], defaultId, defaultSource, probed: notes };
}

/** mimeapps 规范顺序的默认值：用户级 XDG_CONFIG_HOME 优先，其次各 XDG_CONFIG_DIRS，最后 XDG_DATA_DIRS。
 *  取 `[Default Applications]` 的 `x-scheme-handler/https` 首个仍安装的条目。 */
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

/** mimeapps.list 的 `[Default Applications]` 段取 https 项的第一个 id（规范：安装即失效则顺延下一个）。 */
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

/** 一平台的探测分派：平台事实只在这里出现一次，且每条来源都进 probed。
 *  canExec（文件在且可执行）默认落到 exec-path 的实测实现，测试侧整体替换。 */
function probe(platform, d) {
  const pl = platform || process.platform;
  const dd = Object.assign({}, d, { canExec: d.canExec || ((p) => isExecutableFile(p, pl)) });
  if (pl === 'win32') return probeWin(dd);
  if (pl === 'darwin') return probeMac(dd);
  return probeLinux(dd);
}

// 结果按平台缓存：注册表/LaunchServices/XDG 目录扫描都不是廉价查询，面板轮询不得反复触发。
const CACHE = Object.create(null);

/** 完整清单 + 默认项 + 探测留痕。面板可 force 刷新（安装/卸载浏览器后立刻反映）。
 *  @param {{force?:boolean, now?:Function, runOut?, readFile?, exists?, listDir?, canExec?, env?, home?, ttlMs?}} [o] */
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
    // 探测层任何意外都不得变成用户可见的打开失败：如实记下「本次没探到」，选路自会按空清单处理。
    value = { browsers: [], defaultId: null, defaultSource: null, probed: [{ source: 'probe-error', detail: String((e && e.message) || e) }] };
  }
  value.at = now();
  value.platform = pl;
  value.browsers.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  CACHE[pl] = { at: now(), value };
  return Object.assign({ cached: false }, value);
}

/** 缓存只影响下一次探测：安装/卸载浏览器后面板要能立刻反映，故提供显式失效口。 */
function invalidate(platform) {
  if (platform) delete CACHE[platform];
  else for (const k of Object.keys(CACHE)) delete CACHE[k];
}

module.exports = {
  inventory, invalidate, probe, probeWin, probeMac, probeLinux,
  engineOf, tokenizeExec, parseExecLine, exeFromCmdLine,
  // 注册表原语住在 ./registry.js（单一实现），此处原样转出：既有门禁与消费方的取用口不变。
  regValueOf: registry.regValueOf, expandEnvVars, safeRegKeyPart, regKeyFull: registry.regKeyFull,
  regValue, regSubkeys, regValueTargets,
  browserFromDesktop, desktopDirs, resolveLinuxBin, mimeAppsDefault, linuxDefaultFromMimeApps,
  WIN_APP_PATHS, PROBE_TIMEOUT_MS,
};
