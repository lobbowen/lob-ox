#!/usr/bin/env node
'use strict';


const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');

const results = [];
const check = (n, c, x) => {
  results.push(!!c);
  console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  <- ' + x : ''));
};

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'external-open-'));
const src = (...p) => require(path.join(ROOT, 'src', ...p));
const br = src('platform', 'os', 'browser.js');
const env = src('platform', 'os', 'environment.js');
const u = 'http://127.0.0.1:28111/x';
const det = br.detector;

{
  const agreeOn = (inv, pref) => {
    const picked = env.pickLauncher(inv.platform || 'win32', inv, pref);
    const plan = br.openPlan('win32', u, { inventory: inv, preference: pref });
    return plan.pick === picked.how && !!plan.bin === !!picked.browser
      && (picked.browser === null || plan.bin === picked.browser.bin);
  };
  const twoWin = { platform: 'win32', defaultId: null, defaultSource: null, probed: [{ source: 'fixture', detail: '2 项' }],
    browsers: [
      { id: 'c:\\edge\\msedge.exe', name: 'msedge', engine: 'chromium', bin: 'C:\\Edge\\msedge.exe', sources: ['fixture'] },
      { id: 'c:\\ff\\firefox.exe', name: 'firefox', engine: 'firefox', bin: 'C:\\FF\\firefox.exe', sources: ['fixture'] },
    ] };
  const noneWin = { platform: 'win32', defaultId: null, defaultSource: null, probed: [{ source: 'fixture', detail: '0 项' }], browsers: [] };
  check('X-8 分发依据住在环境表单，browser.js 转出的即探测层同一函数（同源 + 居住地）',
    br.engineOf === det.engineOf
    && typeof env.pickLauncher === 'function' && typeof br.openPlan === 'function'
    && [null, 'c:\\ff\\firefox.exe', 'c:\\gone\\x.exe'].every((pref) => agreeOn(twoWin, pref))
    && agreeOn(noneWin, null),
    Object.keys(det).slice(0, 6).join(','));

  const cprof = src('platform', 'os', 'index.js').capabilityProfile;
  check('X-8 四平台矩阵：win32 无调度器(null) / darwin=open / linux=xdg-open / 未知平台 best-effort xdg-open；声明面三端 true、unknown false（不静默尝试）',
    br.openCommand('win32', u) === null
    && JSON.stringify(br.openCommand('darwin', u)) === JSON.stringify({ cmd: 'open', args: [u] })
    && JSON.stringify(br.openCommand('linux', u)) === JSON.stringify({ cmd: 'xdg-open', args: [u] })
    && br.openCommand('freebsd', u).cmd === 'xdg-open'
    && [['linux', true], ['darwin', true], ['win32', true], ['freebsd', false]].every(([p, v]) => cprof(p, 'x64').openBrowser === v),
    ['linux', 'darwin', 'win32', 'freebsd'].map((p) => p + '=' + cprof(p, 'x64').openBrowser).join(','));
  check('入口闸门 isSafeHttpUrl：只放 http(s) 绝对 URL（file:///、javascript:、含 shell 元字符的相对串、空串全拒）',
    br.isSafeHttpUrl(u) === true && br.isSafeHttpUrl('https://a.b/c') === true
    && br.isSafeHttpUrl('file:///c:/windows/system32/calc.exe') === false && br.isSafeHttpUrl('javascript:alert(1)') === false
    && br.isSafeHttpUrl('not a url & calc.exe') === false && br.isSafeHttpUrl('') === false, 'ok');
  check('X-8 engineOf 三族判定：chromium 派生 / firefox 派生 / safari+snap+xdg-open=other（other 永不前置于直启清单）',
    det.engineOf('/usr/bin/chromium-browser') === 'chromium'
    && det.engineOf('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe') === 'chromium'
    && det.engineOf('firefox') === 'firefox' && det.engineOf('/usr/lib/firefox/firefox') === 'firefox'
    && det.engineOf('/Applications/Safari.app/Contents/MacOS/Safari') === 'other'
    && det.engineOf('snap') === 'other' && det.engineOf('xdg-open') === 'other', 'ok');

  check('X-8 win 侧解析：regValueOf 认 REG_SZ/REG_EXPAND_SZ（DWORD/无值=null）+ expandEnvVars 未知变量原样留着（宁可判不可用也不猜路径）+ exeFromCmdLine 引号/裸 exe/非 exe=null',
    det.regValueOf('    (默认)    REG_SZ    Google Chrome') === 'Google Chrome'
    && det.regValueOf('    (默认)    REG_EXPAND_SZ    %ProgramFiles%\\Mozilla Firefox\\firefox.exe') === '%ProgramFiles%\\Mozilla Firefox\\firefox.exe'
    && det.regValueOf('    (默认)    REG_DWORD    1') === null && det.regValueOf(null) === null
    && det.expandEnvVars('%ProgramFiles%\\x\\firefox.exe', { ProgramFiles: 'C:\\Program Files' }) === 'C:\\Program Files\\x\\firefox.exe'
    && det.expandEnvVars('%Nope%\\x', {}) === '%Nope%\\x'
    && det.exeFromCmdLine('"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" -- "%1"') === 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
    && det.exeFromCmdLine('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe -- "%1"') === 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
    && det.exeFromCmdLine('notepad') === null, 'ok');
  // reg.exe 把根名展开后打印（问 HKLM 回 HKEY_LOCAL_MACHINE）：产品若按简写比前缀，真机每行都匹配不上 ⇒ 整个 StartMenuInternet 枚举静默交出空清单。
  const subOf = (text) => det.regSubkeys(() => text, () => {}, 'HKLM\\SOFTWARE\\Clients\\StartMenuInternet');
  check('X-8 posix/键名侧解析：parseExecLine 去壳分词、safeRegKeyPart 拒 shell 活性字符（键名进 reg.exe 的 argv）、regSubkeys 只认完整根名（简写形态反向钉住）',
    JSON.stringify(det.parseExecLine('env DISPLAY=:0 brave-browser --ozone-platform=x11 %U')) === JSON.stringify({ bin: 'brave-browser', baseArgs: ['--ozone-platform=x11'] })
    && JSON.stringify(det.parseExecLine('"google chrome"  --incognito %u')) === JSON.stringify({ bin: 'google chrome', baseArgs: ['--incognito'] })
    && det.parseExecLine('%u') === null
    && det.safeRegKeyPart('ChromeHTML') === true && det.safeRegKeyPart('a&b') === false
    && det.safeRegKeyPart('a\nb') === false && det.safeRegKeyPart('') === false
    && JSON.stringify(subOf('HKEY_LOCAL_MACHINE\\SOFTWARE\\Clients\\StartMenuInternet\\MSEdge\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Clients\\StartMenuInternet\\Firefox\r\n')) === JSON.stringify(['MSEdge', 'Firefox'])
    && subOf('HKLM\\SOFTWARE\\Clients\\StartMenuInternet\\MSEdge\r\n').length === 0
    && det.regKeyFull('HKCU\\Software\\Classes') === 'HKEY_CURRENT_USER\\Software\\Classes', 'ok');

  const UC_KEY = 'HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice';
  const SMI = 'HKLM\\SOFTWARE\\Clients\\StartMenuInternet';
  function fakeReg(o) {
    const values = o.values || {}, named = o.named || {}, subs = o.subs || {};
    const HIVE = { HKLM: 'HKEY_LOCAL_MACHINE', HKCU: 'HKEY_CURRENT_USER', HKCR: 'HKEY_CLASSES_ROOT' };
    const q = (v) => (typeof v === 'string' ? ['REG_SZ', v] : [v.t || 'REG_SZ', v.d]);
    const run = (bin, args) => {
      if (bin !== 'reg.exe' || args[0] !== 'query') return null;
      const key = args[1];
      if (args[2] === '/v') { const v = (named[key] || {})[args[3]]; if (v === undefined) return null; const [t, d] = q(v); return '    ' + args[3] + '    ' + t + '    ' + d + '\r\n'; }
      if (args[2] === '/ve') { const v = values[key]; if (v === undefined) return null; const [t, d] = q(v); return '    (默认)    ' + t + '    ' + d + '\r\n'; }
      const sep = key.indexOf('\\');
      const root = sep < 0 ? key : key.slice(0, sep);
      const fullKey = (HIVE[root.toUpperCase()] || root) + (sep < 0 ? '' : key.slice(sep));
      const lines = (subs[key] || []).map((s) => fullKey + '\\' + s);
      return lines.length ? lines.join('\r\n') + '\r\n' : null;
    };
    run.values = values; run.named = named; run.subs = subs;
    return run;
  }
  const winProbe = (o, canExec) => det.probe('win32', { runOut: o,
    env: { ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)' }, canExec: canExec || (() => true) });
  {
    const r = winProbe(fakeReg({
      named: { [UC_KEY]: { ProgId: 'FirefoxURL' } },
      values: {
        'HKLM\\Software\\Classes\\FirefoxURL\\shell\\open\\command': '"C:\\Program Files\\Mozilla Firefox\\firefox.exe" -osint -url "%1"',
        'HKLM\\Software\\Classes\\MSEdge\\shell\\open\\command': { t: 'REG_EXPAND_SZ', d: '%ProgramFiles(x86)%\\Microsoft\\Edge\\Application\\msedge.exe -- "%1"' },
      },
      subs: { [SMI]: ['MSEdge', 'Firefox'] },
    }));
    check('X-8 探测 win32：UserChoice ProgID -> open\\command 定默认（用户自己选的优先于目录顺序）；StartMenuInternet 目录里的第二个浏览器同时入册；REG_EXPAND_SZ 已展开成绝对路径；每条来源留痕（probed 是面板 diagnostics 的原料）',
      r.defaultId === 'c:\\program files\\mozilla firefox\\firefox.exe' && r.defaultSource === 'userchoice'
      && r.browsers.length === 2 && r.browsers.some((b) => /msedge/.test(b.id))
      && r.browsers.some((b) => b.bin === 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe')
      && r.browsers.every((b) => b.sources.length >= 1) && r.probed.length >= 4
      && r.probed.every((p) => p.source && p.detail !== undefined),
      JSON.stringify({ d: r.defaultId, s: r.defaultSource, n: r.browsers.length, probed: r.probed.length }));
  }
  {
    // StartMenuInternet 默认值自 Win7 起被系统忽略：多候选且系统说不出默认时必须真开窗并把依据摊进证据，而不是报 no-launcher。
    const runOut = fakeReg({ values: { [SMI]: 'MSEdge' }, subs: { [SMI]: ['MSEdge', 'Firefox'], [SMI + '\\MSEdge']: [], [SMI + '\\Firefox']: [] } });
    runOut.values['HKLM\\Software\\Classes\\MSEdge\\shell\\open\\command'] = 'C:\\Edge\\msedge.exe "%1"';
    runOut.values['HKLM\\Software\\Classes\\Firefox\\shell\\open\\command'] = 'C:\\FF\\firefox.exe "%1"';
    const r = winProbe(runOut);
    const picked = env.pickLauncher('win32', r, null);
    check('X-8 StartMenuInternet 默认值不得被当默认项 = UserChoice 被系统忽略；此时两候选仍在册、分发依据落候选次序层（不冒认系统默认、不静默换人、不 no-launcher 死路）',
      r.defaultId === null && r.defaultSource === null && r.browsers.length === 2
      && picked.browser !== null && picked.how === 'candidate-rank',
      JSON.stringify({ d: r.defaultId, s: r.defaultSource, how: picked.how }));
  }
  {
    const scheme = winProbe(fakeReg({ values: {
      'HKCU\\Software\\Classes\\https': 'AppURLMicrosoft Edge',
      'HKCU\\Software\\Classes\\https\\shell\\open\\command': { t: 'REG_EXPAND_SZ', d: '"C:\\Edge\\msedge.exe" -- "%1"' },
    } }));
    const apRun = fakeReg({ values: { 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\brave.exe': 'C:\\Users\\me\\AppData\\Local\\Brave\\brave.exe' } });
    const ok = winProbe(apRun), bad = winProbe(apRun, () => false);
    check('X-8 探测 win32：UserChoice 缺失时以 https 协议关联定默认（来源如实标 scheme-association）；App Paths 单候选=only-installed（不是产品挑内核）；canExec 不过的文件不入册但留痕（「取不到」不等同「没装」）',
      scheme.defaultId === 'c:\\edge\\msedge.exe' && scheme.defaultSource === 'scheme-association'
      && ok.browsers.length === 1 && ok.defaultSource === 'only-installed' && ok.defaultId === 'c:\\users\\me\\appdata\\local\\brave\\brave.exe'
      && bad.browsers.length === 0 && bad.probed.some((p) => /不可执行/.test(String(p.detail))),
      JSON.stringify({ s: scheme.defaultSource, a: ok.defaultSource, bad: bad.probed }));
  }
  {
    const inv = det.inventory('win32', { force: true, now: () => 1000, runOut: () => { throw new Error('reg 被拒'); }, env: {}, canExec: () => true });
    const inv2 = det.inventory('win32', { force: true, now: () => 2000, runOut: fakeReg({}), env: {}, canExec: () => true, ttlMs: 60000 });
    const inv3 = det.inventory('win32', { now: () => 20000, runOut: () => { throw new Error('第二次不该被调用'); }, env: {}, canExec: () => true });
    det.invalidate('win32');
    const inv4 = det.inventory('win32', { now: () => 20000, runOut: fakeReg({}), env: {}, canExec: () => true });
    check('X-8 探测意外（注册表被拒）不抛错、清单为空且带 probe-error 留痕；结果按平台缓存且 force/窗口外会重探；invalidate 后下一次重探（装卸浏览器后面板立刻反映）',
      Array.isArray(inv.browsers) && inv.browsers.length === 0 && inv.probed.some((p) => p.source === 'probe-error')
      && inv2.cached === false && inv3.cached === true && inv4.cached === false,
      JSON.stringify({ err: inv.probed, cached: [inv2.cached, inv3.cached, inv4.cached] }));
  }
  {
    const jxa = (bin, bid, isDef) => [bin, bid, isDef ? '1' : ''].join('\t');
    const out = [jxa('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', 'com.google.chrome', true),
      jxa('/Applications/Firefox.app/Contents/MacOS/firefox', 'org.mozilla.firefox', false)].join('\n');
    const r = det.probe('darwin', { runOut: () => out, canExec: () => true });
    const r2 = det.probe('darwin', { runOut: () => '', canExec: () => true });
    const r3 = det.probe('darwin', { runOut: () => out, canExec: (p) => !/Firefox/.test(p) });
    check('X-8 探测 darwin：LaunchServices 清单两条、默认项取带标记那条；查询无输出（旧系统/权限拦截）=空清单+留痕，不谎报已装；报了但本体不可执行则剔除并留痕',
      r.browsers.length === 2 && r.defaultSource === 'launchservices'
      && r.defaultId === '/applications/google chrome.app/contents/macos/google chrome'
      && r2.browsers.length === 0 && r2.probed.some((p) => p.source === 'launchservices')
      && r3.browsers.length === 1 && r3.probed.some((p) => /不可执行/.test(String(p.detail))),
      JSON.stringify({ d: r.defaultId, n: r.browsers.length, r3: r3.browsers.map((b) => b.bin) }));
  }
  {
    const files = {
      '/usr/share/applications/firefox.desktop': '[Desktop Entry]\nName=Firefox Web Browser\nExec=/usr/lib/firefox/firefox %u\nCategories=Network;WebBrowser;\n\n[Desktop Action new-window]\nExec=/usr/lib/firefox/firefox --new-window %u\n',
      '/usr/share/applications/chromium.desktop': '[Desktop Entry]\nName=Chromium\nExec=env VAR=1 chromium --ozone-platform=x11 %U\nCategories=Network;WebBrowser;\n',
      '/var/lib/snapd/desktop/applications/chromium_chromium.desktop': '[Desktop Entry]\nName=Chromium (snap)\nExec=snap run chromium %U\nCategories=Network;WebBrowser;\n',
      '/home/u/.config/mimeapps.list': '[Default Applications]\nx-scheme-handler/https=chromium.desktop\n',
    };
    const d = {
      runOut: () => null,
      readFile: (p) => { if (!(p in files)) throw new Error('enoent ' + p); return files[p]; },
      exists: (p) => p in files,
      listDir: (p) => Object.keys(files).filter((f) => f.startsWith(p + '/')).map((f) => f.slice(p.length + 1)),
      canExec: (p) => p === '/usr/lib/firefox/firefox' || p === '/usr/bin/chromium',
      env: { PATH: '/usr/bin', XDG_DATA_HOME: '', XDG_CONFIG_HOME: '/home/u/.config' }, home: '/home/u',
    };
    const r = det.probe('linux', d);
    check('X-8 探测 linux：.desktop 主条目 Exec 还原（Desktop Action 段不取）、env 去壳+baseArgs 保留+裸名按 PATH 绝对化、默认项按 mimeapps.list、snap 包装器不入直启清单、id 恒为归一 bin（三平台同一契约，defaultId 靠它定位）',
      r.browsers.some((b) => b.bin === '/usr/lib/firefox/firefox' && JSON.stringify(b.baseArgs) === '[]')
      && r.browsers.some((b) => b.bin === '/usr/bin/chromium' && JSON.stringify(b.baseArgs) === JSON.stringify(['--ozone-platform=x11']))
      && r.defaultId === '/usr/bin/chromium' && r.defaultSource === 'mimeapps'
      && r.browsers.every((b) => b.engine === 'chromium' || b.engine === 'firefox')
      && r.browsers.every((b) => b.id === b.bin.toLowerCase()) && r.browsers.some((b) => b.id === r.defaultId),
      JSON.stringify(r.browsers.map((b) => [b.bin, b.baseArgs, b.engine])));
    const noCfg = det.probe('linux', Object.assign({}, d, { canExec: () => false }));
    const one = det.probe('linux', Object.assign({}, d, {
      readFile: (p) => (p === '/home/u/.config/mimeapps.list' ? '' : files[p]),
      exists: (p) => p === '/usr/lib/firefox/firefox' ? true : (p in files),
      listDir: (p) => Object.keys(files).filter((f) => f.startsWith(p + '/') && !/chromium/.test(f)).map((f) => f.slice(p.length + 1)),
    }));
    check('X-8 探测 linux 反向：全部候选不可执行=空清单（打开时显式 no-launcher，不冒开）；只探到一个浏览器时按唯一解定默认（不是按顺序猜）',
      noCfg.browsers.length === 0 && noCfg.defaultId === null
      && one.browsers.length === 1 && one.defaultSource === 'only-installed',
      JSON.stringify({ none: noCfg.browsers.length, one: one.defaultSource }));
  }

  const brow = (bin, extra) => Object.assign({
    id: String(bin).toLowerCase(), name: String(bin).split(/[\\/]/).pop().replace(/\.exe$/i, ''),
    engine: det.engineOf(bin), bin, sources: ['fixture'],
  }, extra || {});
  const invOf = (list, defId, defSource) => ({ platform: 'fixture', browsers: list, defaultId: defId || null,
    defaultSource: defSource || null, probed: [{ source: 'fixture', detail: list.length + ' 项' }] });
  {
    const ff = brow('/usr/lib/firefox/firefox');
    const chrome = brow('/usr/bin/google-chrome');
    const p = (inv, pref) => env.pickLauncher('linux', inv, pref);
    const base = invOf([chrome, ff], ff.id, 'mimeapps');
    check('X-8 分发依据 1/2 层：用户偏好命中即用并压过系统默认（选过的人不该被系统改口）；无偏好时命中 defaultId 并用 defaultSource 记账、wanted=null；defaultId 指向清单里没有的条目=不命中（探测层与表单同一份数据才谈得上同源）',
      JSON.stringify([p(base, chrome.id).how, p(base, chrome.id).browser, p(base, chrome.id).stale]) === JSON.stringify(['user-preference', chrome, false])
      && p(base, null).browser === ff && p(base, null).how === 'mimeapps' && p(base, null).wanted === null
      && p(invOf([ff], 'no-such-id', 'userchoice'), null).how === 'only-installed',
      JSON.stringify(p(base, chrome.id)));
    check('X-8 分发依据：偏好所指不在候选清单里 = 不静默换人，回落系统默认并标 stale + wanted（面板据此提示重选）',
      p(base, 'c:\\gone\\browser.exe').browser === ff && p(base, 'c:\\gone\\browser.exe').stale === true
      && p(base, 'c:\\gone\\browser.exe').wanted === 'c:\\gone\\browser.exe',
      JSON.stringify(p(base, 'c:\\gone\\browser.exe')));
    check('X-8 判据（计划层）：多候选无默认=候选次序且给出浏览器；单候选=only-installed；空清单/null=none-found 且 browser:null',
      p(invOf([ff]), null).how === 'only-installed'
      && p(invOf([ff, chrome]), null).how === 'candidate-rank' && p(invOf([ff, chrome]), null).browser === chrome
      && p(invOf([]), null).how === 'none-found' && p(invOf([]), null).browser === null
      && p(null, null).how === 'none-found', 'ok');
    const safari = brow('/Applications/Safari.app/Contents/MacOS/Safari');
    check('X-8 候选次序按引擎族分级且与清单顺序无关（other 永不在前，同族按 id 定序）',
      JSON.stringify(env.rankCandidates([safari, ff, chrome]).map((b) => b.id)) === JSON.stringify([chrome.id, ff.id, safari.id])
      && JSON.stringify(env.rankCandidates([chrome, ff, safari]).map((b) => b.id)) === JSON.stringify([chrome.id, ff.id, safari.id])
      && JSON.stringify(env.rankCandidates([brow('/usr/bin/tor-browser'), ff]).map((b) => b.id)) === JSON.stringify([ff.id, '/usr/bin/tor-browser']), 'ok');

    const kl = br.openPlan('linux', u, { inventory: invOf([brow('/usr/bin/google-chrome')]) });
    const kw = br.openPlan('win32', u, { inventory: invOf([brow('C:\\Edge\\msedge.exe')]) });
    const knone = br.openPlan('win32', u, { inventory: invOf([]) });
    const kmany = br.openPlan('win32', u, { inventory: invOf([brow('C:\\Edge\\msedge.exe'), brow('C:\\FF\\firefox.exe')]) });
    const ko = br.openPlan('darwin', u, { inventory: invOf([brow('/Applications/Safari.app/Contents/MacOS/Safari')]) });
    check('X-8 openPlan win32：探到本体=直启（Windows 唯一路，无调度器可退）；探不到任何浏览器=bin:null；多候选而系统说不出默认=按候选次序启并记账 candidate-rank；偏好直通且失效偏好随计划交出 stale',
      kw.bin === 'C:\\Edge\\msedge.exe' && kw.via === 'browser' && kw.engine === 'chromium' && kw.pick === 'only-installed'
      && knone.bin === null && knone.via === 'none' && knone.pick === 'none-found' && knone.exitIsEvidence === false
      && kmany.bin === 'C:\\Edge\\msedge.exe' && kmany.via === 'browser' && kmany.pick === 'candidate-rank'
      && br.openPlan('win32', u, { inventory: invOf([brow('C:\\Edge\\msedge.exe'), brow('C:\\FF\\firefox.exe')]), preference: 'c:\\ff\\firefox.exe' }).pick === 'user-preference'
      && br.openPlan('win32', u, { inventory: invOf([brow('C:\\FF\\firefox.exe')]), preference: 'c:\\gone\\x.exe' }).stale === true,
      JSON.stringify(kmany));
    check('X-8 openPlan linux/darwin 无解析结果=文档化调度器且 exitIsEvidence:true（0 即接收、非 0 即拒绝）；other 引擎（Safari/snap 包装器）在非 win32 交回调度器（裸 URL 参数语义不确定）；win32 对 other 仍直启（引擎不明只等于不可取证）',
      br.openPlan('linux', u, { inventory: invOf([]) }).bin === 'xdg-open' && br.openPlan('linux', u, { inventory: invOf([]) }).exitIsEvidence === true
      && br.openPlan('darwin', u, { inventory: invOf([]) }).bin === 'open' && br.openPlan('darwin', u, { inventory: invOf([]) }).exitIsEvidence === true
      && ko.via === 'dispatcher' && ko.bin === 'open' && ko.engine === 'other'
      && br.openPlan('win32', u, { inventory: invOf([brow('C:\\Tools\\weirdbrowser.exe')]) }).via === 'browser', 'ok');
    check('X-8 openPlan 解析到 chromium=直启该浏览器（baseArgs 在前、url 收尾、绝不注入隔离参数）；直启浏览器一律 exitIsEvidence:false（裸 URL 可被既有实例吸收，本次退出码不属于那个窗口，两向都不作证据）',
      kl.bin === '/usr/bin/google-chrome' && kl.via === 'browser' && kl.engine === 'chromium'
      && JSON.stringify(kl.args) === JSON.stringify([u]) && kl.isolated === false && kl.watch === false && kl.exitIsEvidence === false
      && kw.exitIsEvidence === false
      && JSON.stringify(br.openPlan('linux', u, { inventory: invOf([brow('brave-browser', { baseArgs: ['--ozone-platform=x11'] })]) }).args) === JSON.stringify(['--ozone-platform=x11', u]), JSON.stringify(kl));
    check('X-8 证据规则只在 ownsItsWindow 一处：隔离窗口=恒真，三端调度器=非 win32，两种浏览器形态=恒 false（win32/linux 同判，不按平台分叉）',
      br.ownsItsWindow('isolated', 'linux') === true && br.ownsItsWindow('isolated', 'win32') === true
      && br.ownsItsWindow('dispatcher', 'linux') === true && br.ownsItsWindow('dispatcher', 'darwin') === true
      && br.ownsItsWindow('dispatcher', 'win32') === false
      && br.ownsItsWindow('browser', 'win32') === false && br.ownsItsWindow('browser', 'linux') === false, 'ok');

    const pc = br.isolatedPlan('linux', u, { inventory: invOf([brow('/usr/bin/google-chrome', { baseArgs: [] })]), profileDir: '/P' });
    const pf = br.isolatedPlan('linux', u, { inventory: invOf([brow('/usr/lib/firefox/firefox')]), profileDir: '/P' });
    const ps = br.isolatedPlan('darwin', u, { inventory: invOf([brow('/Applications/Safari.app/Contents/MacOS/Safari')]), profileDir: '/P' });
    const pn = br.isolatedPlan('win32', u, { inventory: invOf([]), profileDir: '/P' });
    const pg = br.isolatedPlan('linux', u, { inventory: invOf([brow('/usr/bin/google-chrome')]) });
    const pb = br.isolatedPlan('linux', u, { inventory: invOf([brow('brave-browser', { baseArgs: ['--ozone-platform=x11'] })]), profileDir: '/P' });
    const pbn = br.isolatedPlan('win32', u, { inventory: invOf([brow('C:\\Edge\\msedge.exe')]), profileDir: '/P' });
    check('X-8 隔离计划（chromium）=user-data-dir + 首启动静音参数 + url 收尾且无 cmd；（firefox）=--no-remote --profile <tmp>（新实例，退出可监听）；desktop baseArgs 原样带入（隔离参数在其后、url 收尾）；反向：argv 里没有 --lang/--window-size/--incognito/-private-window（独立 profile 已用完即删，界面语言与窗口尺寸属用户看得见的一面）',
      pc.bin === '/usr/bin/google-chrome' && pc.isolated === true && pc.watch === true && pc.envKind === 'anti'
      && JSON.stringify(pc.args) === JSON.stringify(['--user-data-dir=/P', '--no-first-run', '--no-default-browser-check', '--disable-session-crashed-bubble', u])
      && pf.isolated === true && JSON.stringify(pf.args) === JSON.stringify(['--no-remote', '--profile', '/P', u])
      && JSON.stringify(pb.args) === JSON.stringify(['--ozone-platform=x11', '--user-data-dir=/P', '--no-first-run', '--no-default-browser-check', '--disable-session-crashed-bubble', u])
      && [pc, pf].every((p) => !p.args.some((a) => /^--(lang|window-size|incognito)\b/.test(String(a)) || String(a) === '-private-window')),
      JSON.stringify([pc.args, pf.args]));
    check('X-8 隔离计划降级如实：Safari 默认=open 非隔离兜底（isolated:false/watch:false）；win32 解析不到=bin:null（由预检如实报 no-launcher，不再 explorer.exe 兜底）；chromium 但缺 profileDir 不冒充隔离（防并入既有实例后 onExit 恒误报）',
      ps.bin === 'open' && ps.isolated === false && ps.watch === false && JSON.stringify(ps.args) === JSON.stringify([u])
      && pn.bin === null && pn.isolated === false && pg.isolated === false && pg.bin === '/usr/bin/google-chrome',
      JSON.stringify([ps, pn, pg]));
    check('X-8 win32 隔离计划与 openPlan 同一本体（登录窗口与外部打开不得是两个浏览器）；隔离形态自带取证档位 via=isolated 且 exitIsEvidence=true，降级路径两向皆 false',
      pbn.bin === 'C:\\Edge\\msedge.exe' && pbn.isolated === true && pbn.watch === true
      && pc.via === 'isolated' && pc.exitIsEvidence === true && pf.via === 'isolated' && pf.exitIsEvidence === true
      && pbn.via === 'isolated' && pbn.exitIsEvidence === true
      && pg.exitIsEvidence === false && pg.via === 'browser' && pg.envKind === 'sys'
      && ps.exitIsEvidence === true && ps.via === 'dispatcher' && pn.exitIsEvidence === false && pn.label === null,
      JSON.stringify([pg, ps]));
    check('X-8 隔离计划与 openPlan 同一份分发依据：偏好/次序在登录窗口同样生效',
      br.isolatedPlan('win32', u, { inventory: invOf([brow('C:\\Edge\\msedge.exe'), brow('C:\\FF\\firefox.exe')]), preference: 'c:\\ff\\firefox.exe', profileDir: '/P' }).pick === 'user-preference'
      && br.isolatedPlan('win32', u, { inventory: invOf([brow('C:\\Edge\\msedge.exe'), brow('C:\\FF\\firefox.exe')]) }).bin === 'C:\\Edge\\msedge.exe', 'ok');

    const manyInv = invOf([brow('C:\\Edge\\msedge.exe', { name: 'msedge' }), brow('C:\\FF\\firefox.exe', { name: 'firefox' })], 'c:\\ff\\firefox.exe', 'userchoice');
    const dg = br.launchDiagnostics(manyInv, kmany, env.pickLauncher('win32', manyInv, null));
    check('X-8 诊断带全部候选/默认项来源/probed 留痕；带偏好面（无偏好=null，命中与失效由同一次分发依据定出，界面侧不另算一遍）；空清单的诊断仍是空清单（不把「没探到」写成「探到 0 个」）',
      dg.pick === 'userchoice' && dg.found.length === 2 && dg.found.every((f) => f.name && f.engine && f.via)
      && JSON.stringify(dg.default) === JSON.stringify({ id: 'c:\\ff\\firefox.exe', source: 'userchoice' }) && dg.probed.length === 1
      && dg.preference === null
      && JSON.stringify(br.launchDiagnostics(manyInv, kmany, env.pickLauncher('win32', manyInv, 'c:\\ff\\firefox.exe')).preference) === JSON.stringify({ id: 'c:\\ff\\firefox.exe', matched: true })
      && JSON.stringify(br.launchDiagnostics(manyInv, kmany, env.pickLauncher('win32', manyInv, 'c:\\gone\\x.exe')).preference) === JSON.stringify({ id: 'c:\\gone\\x.exe', matched: false })
      && JSON.stringify(br.launchDiagnostics(invOf([]), knone, env.pickLauncher('win32', invOf([]), null)).found) === '[]',
      JSON.stringify(dg));
  }
}

{
  const fixtureInv = () => ({
    platform: 'fixture',
    browsers: [
      { id: 'b-firefox', name: 'Firefox', bin: '/usr/bin/firefox', engine: 'firefox', sources: ['fixture'] },
      { id: 'b-chrome', name: 'Chrome', bin: '/usr/bin/chrome', engine: 'chromium', sources: ['fixture'] },
    ],
    defaultId: null, defaultSource: null, probed: [{ source: 'fixture', detail: '2 项' }],
  });
  const saved = { home: process.env.DSH_SUPERVISOR_HOME, bound: Object.assign({}, env.bind()) };
  env.bind({ capabilities: undefined });
  const f1 = env.form({ force: true, inventory: fixtureInv(), now: () => 111 });
  check('X-12 每条结论带留痕来源且分发结论随行（section/source/detail 成对，pick 是后续动作的唯一依据）；候选行经规整后交面板与选路共用（engine 恒有值、isDefault 标定、baseArgs 恒数组）；能力矩阵未注入不冒充档位',
    ['browsers', 'session', 'capabilities', 'preference', 'pick'].every((s) => f1.probed.some((p) => p.section === s && typeof p.source === 'string' && typeof p.detail === 'string'))
    && f1.pick.how === 'candidate-rank' && f1.pick.id === 'b-chrome' && f1.preference.reason === 'not-set'
    && f1.browsers.length === 2 && f1.browsers.every((b) => !!b.engine && Array.isArray(b.baseArgs) && typeof b.isDefault === 'boolean' && b.sources.length === 1)
    && f1.browsers.every((b) => b.isDefault === false)
    && f1.capabilities === null && /未绑定能力矩阵/.test(JSON.stringify(f1.probed)),
    JSON.stringify([f1.pick, f1.probed.map((p) => p.section)]));
  env.bind({ capabilities: () => ({ platform: 'fixture', openBrowser: false }) });
  const fCap = env.form({ force: true, inventory: fixtureInv(), now: () => 112 });
  check('X-12 能力矩阵经装配期注入即如实转出（报的就是注入的那一份，不吞也不自造第二套档位）',
    !!fCap.capabilities && fCap.capabilities.openBrowser === false
    && fCap.sections.capabilities.state === 'ok' && fCap.sections.capabilities.openBrowser === false
    && /openBrowser=false/.test(JSON.stringify(fCap.probed)) && !/未绑定能力矩阵/.test(JSON.stringify(fCap.probed)),
    JSON.stringify(fCap.probed.filter((p) => p.section === 'capabilities')));
  env.bind({ capabilities: saved.bound.capabilities });
  const cp = (v) => env.checkPreference(v, f1);
  check('X-12 偏好判据：命中候选=可写、空值/非字符串=清除、非候选=拒写并给一句话与候选表（不猜意图）',
    cp('b-firefox').ok === true && cp('b-firefox').browser.id === 'b-firefox'
    && cp('').ok === true && cp('').id === null && cp(null).id === null && cp(42).id === null
    && cp('nope').ok === false && typeof cp('nope').error === 'string' && cp('nope').browser === null && cp('nope').candidates.length === 2,
    JSON.stringify(cp('nope')));
  env.bind({ preference: () => 'b-firefox' });
  const f3 = env.form({ force: true, inventory: fixtureInv() });
  env.bind({ preference: () => 'b-gone' });
  const f4 = env.form({ force: true, inventory: fixtureInv() });
  check('X-12 偏好经装配期注入即全局生效（调用点不传参）；所指消失时自证 stale 并给回落依据（不静默换人）',
    f3.preference.configured === true && f3.preference.matched === true && f3.preference.browser.id === 'b-firefox'
    && f3.pick.how === 'user-preference' && f3.pick.id === 'b-firefox' && f3.pick.stale === false
    && f4.preference.reason === 'stale' && f4.preference.browser === null && f4.pick.stale === true
    && f4.pick.wanted === 'b-gone' && f4.pick.how === 'candidate-rank',
    JSON.stringify([f3.pick, f4.preference, f4.pick]));
  env.bind({ preference: saved.bound.preference, capabilities: saved.bound.capabilities });

  const home = path.join(TMP, 'x12-state');
  process.env.DSH_SUPERVISOR_HOME = home;
  const snapPath = env.snapshotPath();
  const fNoPersist = env.form({ force: true, inventory: fixtureInv() });
  const notWritten = !fs.existsSync(snapPath);
  const f2 = env.form({ force: true, persist: true, inventory: fixtureInv() });
  const bits = fs.statSync(snapPath).mode & 0o777;
  check('X-12 读路径零写盘（面板轮询不在状态目录留副作用，快照只随人主动刷新落一次）；快照落在状态目录、带 schema、POSIX 权限只给用户自己（win32 无 POSIX 权限位）',
    fNoPersist.snapshot.written === false && notWritten && fNoPersist.snapshot.path === snapPath
    && snapPath === path.join(env.paths().supervisor, env.FILE_NAME) && f2.snapshot.written === true
    && (process.platform === 'win32' ? true : bits === 0o600) && env.readSnapshot().schema === env.SCHEMA,
    'mode=' + bits.toString(8) + ' ' + snapPath);

  if (saved.home === undefined) delete process.env.DSH_SUPERVISOR_HOME;
  else process.env.DSH_SUPERVISOR_HOME = saved.home;
  fs.rmSync(home, { recursive: true, force: true });
  env.invalidate();
}

async function x10() {
  const U = 'http://127.0.0.1:28111/open?code=c1';
  const spawned = [];
  const okSpawn = (bin, args) => { spawned.push([bin, args]); return { fake: true }; };
  const obs = (spec) => async () => spec;
  const EX_OK = { stage: 'exit', code: 0, signal: null };
  function vocabOk(r) {
    if (r.ok !== (r.reason === null)) return 'ok/reason 互斥被破坏';
    if (r.ok && r.confirmed === r.handedOff) return 'confirmed/handedOff 必须恰好一个为真';
    if (!r.ok && (typeof r.error !== 'string' || !r.error)) return '失败必须带给用户的一句话';
    if (r.ok && !r.message) return '成功必须带文案';
    if (!r.ok && r.message !== null) return '失败不得带成功文案';
    return null;
  }
  const B = (bin) => ({ id: String(bin).toLowerCase(), name: String(bin).split(/[\\/]/).pop(), engine: det.engineOf(bin), bin, sources: ['fixture'] });
  const IN = (list, defId, defSource) => ({ platform: 'fixture', browsers: list, defaultId: defId || null,
    defaultSource: defSource || null, probed: [{ source: 'fixture', detail: list.length + ' 项' }] });
  const NO_INV = IN([]);
  const EDGE_WIN = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  const cases = [
    ['linux 调度器 0 退出 -> confirmed（0 即接收）', U, { platform: 'linux', inventory: NO_INV, observe: obs(EX_OK), spawn: okSpawn, binAvailable: () => true },
      (r) => r.ok === true && r.confirmed === true && r.handedOff === false, ['dispatcher', 'xdg-open']],
    ['win32 多候选且系统说不出默认 = 按候选次序直启，依据留在证据里（不再 no-launcher 死路）', U,
      { platform: 'win32', inventory: IN([B(EDGE_WIN), B('C:\\FF\\firefox.exe')]), observe: obs(EX_OK), spawn: okSpawn, binAvailable: () => true },
      (r) => r.ok === true && r.evidence.via === 'browser' && r.evidence.bin === EDGE_WIN
        && r.evidence.diagnostics.pick === 'candidate-rank' && r.evidence.diagnostics.preference === null, ['browser', EDGE_WIN]],
    ['win32 探到 msedge 非 0 退出 -> handedOff（不可信形态的非 0 不判失败，也不冒领成功）', U,
      { platform: 'win32', inventory: IN([B(EDGE_WIN)]), observe: obs({ stage: 'exit', code: 1, signal: null }), spawn: okSpawn, binAvailable: () => true },
      (r) => r.ok === true && r.handedOff === true && r.reason === null && r.evidence.exitCode === 1
        && r.evidence.engine === 'chromium' && r.evidence.ownsWindow === false, ['browser', EDGE_WIN]],
    ['解析到 chromium 直启 0 退出 -> handedOff（不再冒领 confirmed）', U,
      { platform: 'linux', inventory: IN([B('/usr/bin/google-chrome')]), observe: obs(EX_OK), spawn: okSpawn, binAvailable: () => true },
      (r) => r.ok === true && r.confirmed === false && r.evidence.bin === '/usr/bin/google-chrome' && r.evidence.ownsWindow === false,
      ['browser', '/usr/bin/google-chrome']],
    ['可信形态窗口内仍存活 -> 依旧 handedOff（证据规则不能替无证据背书）', U,
      { platform: 'linux', inventory: NO_INV, observe: obs({ stage: 'alive' }), spawn: okSpawn, binAvailable: () => true },
      (r) => r.ok === true && r.confirmed === false && r.handedOff === true && r.evidence.ownsWindow === true, ['dispatcher', 'xdg-open']],
    ['error 事件（ENOENT）-> ok:false/spawn-failed', U,
      { platform: 'linux', inventory: NO_INV, observe: obs({ stage: 'error', code: 'ENOENT' }), spawn: okSpawn, binAvailable: () => true },
      (r) => r.ok === false && r.reason === 'spawn-failed' && r.evidence.error === 'ENOENT', ['dispatcher', 'xdg-open']],
    ['可信形态非 0 退出 -> ok:false/exit-nonzero（带退出码；证据规则没砍掉真失败信号）', U,
      { platform: 'linux', inventory: NO_INV, observe: obs({ stage: 'exit', code: 3, signal: null }), spawn: okSpawn, binAvailable: () => true },
      (r) => r.ok === false && r.reason === 'exit-nonzero' && /3/.test(r.error) && r.evidence.ownsWindow === true, ['dispatcher', 'xdg-open']],
    ['可信形态信号终止 -> ok:false/killed-by-signal', U,
      { platform: 'linux', inventory: NO_INV, observe: obs({ stage: 'exit', code: null, signal: 'SIGKILL' }), spawn: okSpawn, binAvailable: () => true },
      (r) => r.ok === false && r.reason === 'killed-by-signal' && r.evidence.exitSignal === 'SIGKILL', ['dispatcher', 'xdg-open']],
    ['证据必带探测诊断（pick/found/probed/default 四项在场，否则真机无从定性）', U,
      { platform: 'win32', inventory: IN([B(EDGE_WIN), B('C:\\FF\\firefox.exe')], 'c:\\ff\\firefox.exe', 'userchoice'), observe: obs(EX_OK), spawn: okSpawn, binAvailable: () => true },
      (r) => { const d = r.evidence && r.evidence.diagnostics;
        return !!d && d.pick === 'userchoice' && d.found.length === 2 && d.found.every((f) => f.name && f.engine && f.via === 'fixture')
          && !!d.default && d.default.source === 'userchoice' && d.probed.length === 1; }, ['browser', 'C:\\FF\\firefox.exe']],
  ];
  for (const [name, url, opts, judge, form] of cases) {
    const rows = [];
    const lg = { info: (m) => rows.push(String(m)), warn: (m) => rows.push(String(m)) };
    const r = await br.openBrowser(url, Object.assign({}, opts, { logger: lg }));
    const got = r.evidence ? [r.evidence.via, r.evidence.bin] : [];
    const formOk = !form || (got[0] === form[0] && (!form[1] || got[1] === form[1]));
    check('X-10 ' + name, judge(r) && vocabOk(r) === null && formOk && rows.length === 1,
      (vocabOk(r) || '') + (formOk ? '' : '形态漂移，实走 ' + got.join('/') + ' ') + (rows.length === 1 ? '' : '日志行数=' + rows.length + ' ') + JSON.stringify(r));
  }
  // 日志不是令牌的家：普通打开的地址带 ?token=，argv 摘要必须截掉查询串与片段，同时留住 origin+path。
  {
    const rows = [];
    const lg = { info: (m) => rows.push(String(m)), warn: (m) => rows.push(String(m)) };
    const r = await br.openBrowser('http://127.0.0.1:28111/?token=AbC123def-456',
      { platform: 'linux', inventory: NO_INV, observe: obs(EX_OK), spawn: okSpawn, binAvailable: () => true, logger: lg });
    const line = rows[0] || '';
    check('X-10 带令牌地址仍恰落一行：令牌值与整个查询串不入日志、地址主体可比对，且写明档位与分发依据',
      rows.length === 1 && r.ok === true && !/AbC123def-456/.test(line) && !/\?token=/.test(line) && /127\.0\.0\.1:28111/.test(line)
      && /\[open\] intent=plain via=dispatcher.*=> confirmed/.test(line), line);
  }
  spawned.length = 0;
  const rFile = await br.openBrowser('file:///c:/windows/system32/calc.exe', { platform: 'linux', inventory: NO_INV, spawn: okSpawn, binAvailable: () => true });
  const rEmpty = await br.openBrowser('', { platform: 'linux', inventory: NO_INV, spawn: okSpawn, binAvailable: () => true });
  check('X-10 反向（零 spawn）：非 http(s) 地址与空地址 -> unsafe-url（不把地址交给系统）',
    rFile.ok === false && rFile.reason === 'unsafe-url' && rEmpty.ok === false && rEmpty.reason === 'unsafe-url'
    && rFile.url === 'file:///c:/windows/system32/calc.exe' && spawned.length === 0, JSON.stringify([rFile, rEmpty]));
  const zero = [
    ['未知平台 freebsd：档位说不开就显式失败（openCommand 仍会试 xdg-open，那是低层映射）', U,
      { platform: 'freebsd', inventory: NO_INV, spawn: okSpawn, binAvailable: () => true, observe: obs(EX_OK) }, 'unsupported-platform'],
    ['linux 无图形会话', U, { platform: 'linux', inventory: NO_INV, spawn: okSpawn, binAvailable: () => true, desktopAvailable: () => false }, 'no-desktop-session'],
    ['启动命令不在 PATH', U, { platform: 'linux', inventory: NO_INV, spawn: okSpawn, binAvailable: () => false }, 'no-launcher'],
    ['win32 探测清单为空 = 选不出启动对象（不再退 explorer.exe 冒开），留痕一起交出', U,
      { platform: 'win32', inventory: NO_INV, spawn: okSpawn, binAvailable: () => true, observe: obs(EX_OK) }, 'no-launcher'],
  ];
  for (const [name, url, opts, reason] of zero) {
    spawned.length = 0;
    const r = await br.openBrowser(url, opts);
    const diagOk = reason !== 'no-launcher'
      || (!!r.evidence && !!r.evidence.diagnostics && Array.isArray(r.evidence.diagnostics.found) && r.evidence.diagnostics.probed.length === 1);
    check('X-10 反向（零 spawn）：' + name + ' -> ' + reason,
      r.ok === false && r.reason === reason && spawned.length === 0 && r.url === url && diagOk,
      'spawn ' + spawned.length + ' 次 ' + JSON.stringify(r));
  }
  spawned.length = 0;
  const rProbeErr = await br.openBrowser(U, { platform: 'win32', spawn: okSpawn, binAvailable: () => true, observe: obs(EX_OK),
    resolveInventory: () => ({ platform: 'win32', browsers: [], defaultId: null, defaultSource: null, probed: [{ source: 'probe-error', detail: 'reg 被拒' }] }) });
  check('X-10 探测意外退化为空清单后仍走 no-launcher 档，且 probe-error 留痕抵达证据（否则等于没报根因）',
    rProbeErr.ok === false && rProbeErr.reason === 'no-launcher' && rProbeErr.url === U && spawned.length === 0
    && JSON.stringify(rProbeErr.evidence.diagnostics.probed) === JSON.stringify([{ source: 'probe-error', detail: 'reg 被拒' }]), JSON.stringify(rProbeErr));
  const rThrow = await br.openBrowser(U, { platform: 'linux', inventory: NO_INV, binAvailable: () => true, spawn: () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); } });
  const rNull = await br.openBrowser(U, { platform: 'linux', inventory: NO_INV, binAvailable: () => true, spawn: () => null });
  const rUrl = await br.openBrowser(U, { platform: 'linux', inventory: NO_INV, observe: obs(EX_OK), spawn: okSpawn, binAvailable: () => true });
  check('X-10 spawn 同步抛错与返回空句柄 -> ok:false/spawn-failed；结果恒原样带回 url',
    rThrow.ok === false && rThrow.reason === 'spawn-failed' && rThrow.evidence.error === 'EACCES'
    && rNull.ok === false && rNull.reason === 'spawn-failed' && rUrl.url === U, JSON.stringify([rThrow, rNull]));

  const { EventEmitter } = require('node:events');
  const fireExit = (code, signal) => { const e = new EventEmitter(); const p = br.observeSpawn(e, 5000, () => ({ unref() {} })); e.emit('exit', code, signal); return p; };
  const o1 = await fireExit(0, null);
  const o2 = await (async () => {
    const e = new EventEmitter();
    const p = br.observeSpawn(e, 5000, () => ({ unref() {} }));
    e.emit('error', Object.assign(new Error('x'), { code: 'ENOENT' }));
    e.emit('exit', 0, null);
    return p;
  })();
  check('X-10 observeSpawn：先到者定局（exit 如实带码/信号；error 后 emit exit 仍判 error，后到事件不得翻案）',
    o1.stage === 'exit' && o1.code === 0 && o1.signal === null && o2.stage === 'error' && o2.code === 'ENOENT', JSON.stringify([o1, o2]));
  let armed = null, unrefed = 0;
  const e3 = new EventEmitter();
  const p3 = br.observeSpawn(e3, 1234, (fn) => { armed = fn; return { unref() { unrefed++; } }; });
  armed();
  const o3 = await p3;
  check('X-10 observeSpawn：窗口内无事件 -> stage:alive（既不判成功也不判失败，交回 handedOff）；计时句柄被 unref（观测不得拖住进程退出）',
    o3.stage === 'alive' && o3.code === undefined && unrefed === 1, JSON.stringify([o3, 'unref=' + unrefed]));

  const EG_OK = { at: 1, proxy: { state: 'unknown', source: 'fixture' },
    targets: { '127.0.0.1': { ok: true, stage: 'tls', detail: 'fixture', at: 1 } }, probed: [] };
  {
    const chromeInv = IN([B('/usr/bin/google-chrome')]);
    const removed = [];
    let isoSpawnArgs = null, isoEnv = null, isoOnExit = 'unset';
    const onExit = () => {};
    const isoSpawn = (bin, args, e2, cb) => { spawned.push([bin, args]); isoSpawnArgs = args; isoEnv = e2; isoOnExit = cb; return { fake: true }; };
    const li = await br.openBrowser(U, { platform: 'linux', inventory: chromeInv, intent: 'isolated-login', observe: obs(EX_OK), egress: EG_OK,
      spawn: isoSpawn, binAvailable: () => true, allocProfile: () => '/P', rmTree: (p, ms) => removed.push([p, ms]),
      profileMs: 5000, onExit, rand: () => 0 });
    check('X-10 隔离登录同词汇同档位：独立 profile 必为新实例，0 退出即 confirmed（登录窗口的退出码双向可证）；证据带 via/isolated/watch/ownsWindow/profile 与探测诊断、出网结论（basis/host/viable 三项在场）',
      vocabOk(li) === null && li.ok === true && li.confirmed === true && li.handedOff === false
      && li.evidence.via === 'isolated' && li.evidence.isolated === true && li.evidence.watch === true && li.evidence.ownsWindow === true
      && li.evidence.profile === '/P' && li.url === U
      && li.evidence.diagnostics.found.length === 1 && li.evidence.diagnostics.pick === 'only-installed'
      && li.evidence.egress.basis === 'target-reachable' && li.evidence.egress.viable === true && li.evidence.egress.host === '127.0.0.1',
      JSON.stringify(li.evidence));
    const ia = isoSpawnArgs || [];
    check('X-10 隔离登录的 argv 走最小隔离方言：user-data-dir 开头、静音参数居中、url 收尾、长度 5',
      ia[0] === '--user-data-dir=/P'
      && ia.slice(1, 4).join(',') === '--no-first-run,--no-default-browser-check,--disable-session-crashed-bubble'
      && ia[ia.length - 1] === U && ia.length === 5, JSON.stringify(ia));
    // 反指纹档相对宿主档只多改一项（TZ），不得随机化界面语言；宿主自带 TZ 会让差集为空，故先摘掉再比。
    const savedTZ = process.env.TZ;
    delete process.env.TZ;
    const le = br.loginEnv(() => 0.5);
    const injected = Object.keys(le.antiEnv).filter((k) => le.sysEnv[k] !== le.antiEnv[k]);
    if (savedTZ === undefined) delete process.env.TZ; else process.env.TZ = savedTZ;
    check('X-10 判据：反指纹档相对宿主档只改 TZ 一项（宿主 LANG 原样带过，不再随机化界面语言 => 中文 Windows 不会弹法语窗口）',
      JSON.stringify(injected) === JSON.stringify(['TZ']) && !!isoEnv && typeof isoEnv.TZ === 'string' && !!isoEnv.TZ && isoEnv.LANG === le.sysEnv.LANG,
      JSON.stringify([injected, isoEnv && isoEnv.TZ]));
    check('X-10 只在 watch 形态将关闭回调接到 spawn（并入既有实例时 onExit 恒误报，宁可不接）；成功后延迟回收临时 profile（一次登录留一个目录 = 磁盘上的孤儿）',
      isoOnExit === onExit && JSON.stringify(removed) === JSON.stringify([['/P', 5000]]), JSON.stringify([String(isoOnExit), removed]));
    spawned.length = 0; isoOnExit = 'unset';
    const ld = await br.openBrowser(U, { platform: 'darwin', inventory: NO_INV, intent: 'isolated-login', observe: obs({ stage: 'alive' }), egress: EG_OK,
      spawn: (b, a, e2, cb) => { isoOnExit = cb; return { fake: true }; }, binAvailable: () => true, profileMs: 5000, onExit });
    check('X-10 隔离登录降级如实（无可信调度器/无方言时 isolated:false、只到 handedOff、不挂 onExit）',
      vocabOk(ld) === null && ld.ok === true && ld.confirmed === false && ld.handedOff === true
      && ld.evidence.isolated === false && ld.evidence.profile === null && ld.evidence.watch === false
      && ld.evidence.via === 'dispatcher' && isoOnExit === undefined, JSON.stringify(ld));
    spawned.length = 0; removed.length = 0;
    const ln = await br.openBrowser(U, { platform: 'linux', inventory: chromeInv, intent: 'isolated-login', spawn: okSpawn, egress: EG_OK,
      binAvailable: () => false, desktopAvailable: () => false, allocProfile: () => '/P', rmTree: (p, ms) => removed.push([p, ms]) });
    const lb = await br.openBrowser('file:///etc/passwd', { platform: 'linux', intent: 'isolated-login', binAvailable: () => true, spawn: okSpawn });
    check('X-10 隔离登录吃同一套预检：无图形会话即 no-desktop-session、零 spawn 且已分配 profile 被回收；失败也带 reason/url/error',
      vocabOk(ln) === null && ln.ok === false && ln.reason === 'no-desktop-session' && spawned.length === 0 && ln.url === U
      && !!ln.error && JSON.stringify(removed) === JSON.stringify([['/P', 0]])
      && vocabOk(lb) === null && lb.ok === false && lb.reason === 'unsafe-url' && !!lb.error, JSON.stringify([ln, removed]));
    spawned.length = 0;
    const lp = await br.openBrowser(U, { platform: 'win32', inventory: IN([B(EDGE_WIN), B('C:\\FF\\firefox.exe')]), preference: 'c:\\ff\\firefox.exe',
      intent: 'isolated-login', observe: obs(EX_OK), spawn: okSpawn, binAvailable: () => true, allocProfile: () => '/P', rmTree: () => {}, egress: EG_OK });
    check('X-10 隔离登录与直启共用分发依据：偏好命中即 firefox 的 --no-remote --profile 形态',
      lp.ok === true && lp.evidence.bin === 'C:\\FF\\firefox.exe' && lp.evidence.isolated === true
      && lp.evidence.diagnostics.pick === 'user-preference', JSON.stringify(lp.evidence));
  }
}

async function x13() {
  const eg = src('platform', 'os', 'egress.js');
  const reg = src('platform', 'os', 'registry.js');
  const red = src('platform', 'util', 'redact.js');
  const sr = src('platform', 'contract', 'shell-report.js');
  const T = 'login.example.test';
  const url = 'https://' + T + '/callback?state=x13';
  const rd = (ok, stage, detail) => ({ ok, stage, detail, at: 7 });
  const EG = (proxyState, target) => ({ at: 7, proxy: { state: proxyState, source: 'fixture', server: null, pac: null },
    targets: target ? { [T]: target } : {}, probed: [] });
  const note = () => {};
  const NO_INV = { platform: 'fixture', browsers: [], defaultId: null, defaultSource: null, probed: [] };
  const viable = (data) => env.coldProfileViable(data, T);

  check('X-13 冷档案判据：直连可达 / 不通但代理在用 -> 照开（冷档案继承系统/环境代理）；不通且代理明确没有 -> 降档 cold-profile-blocked',
    viable(EG('off', rd(true, 'tls', 'fixture'))).viable === true && viable(EG('off', rd(true, 'tls', 'fixture'))).basis === 'target-reachable'
    && viable(EG('on', rd(false, 'dns', 'ENOTFOUND'))).viable === true && viable(EG('on', rd(false, 'dns', 'ENOTFOUND'))).basis === 'cold-profile-inherits-proxy'
    && viable(EG('off', rd(false, 'dns', 'ENOTFOUND'))).viable === false && viable(EG('off', rd(false, 'dns', 'ENOTFOUND'))).basis === 'cold-profile-blocked',
    JSON.stringify(viable(EG('off', rd(false, 'dns', 'ENOTFOUND')))));
  check('X-13 判不出即保持隔离：代理读不出 / 通路本身判不出 / 该主机还没判过 -> viable:null；缺维度即如实 unprobed（拿空数据冒充本机实况是最难查的假账，也不许顺手砍能力）',
    viable(EG('unknown', rd(false, 'dns', 'ENOTFOUND'))).viable === null && viable(EG('unknown', rd(false, 'dns', 'ENOTFOUND'))).basis === 'proxy-unreadable'
    && viable(EG('off', rd(null, 'tcp', 'ETIMEDOUT'))).viable === null && viable(EG('off', rd(null, 'tcp', 'ETIMEDOUT'))).basis === 'egress-undetermined'
    && viable(EG('off', null)).basis === 'egress-undetermined'
    && viable(null).viable === null && viable(null).basis === 'egress-unprobed', 'ok');
  const ce = await env.checkEgress(url, { egress: EG('off', rd(true, 'tls', 'fixture')) });
  const ceBad = await env.checkEgress('读不出主机的地址', { egress: EG('unknown', null) });
  check('X-13 checkEgress 交出 host/结论/依据码/代理档/时戳（结论要一路走到屏幕上，不能只活在判据里）；地址读不出主机名 -> 判不出而不是抛错（出网探测不得成为用户可见的失败原因）',
    ce.host === T && ce.viable === true && ce.basis === 'target-reachable' && ce.proxy === 'off' && ce.at === 7
    && ceBad.host === null && ceBad.viable === null && typeof ceBad.basis === 'string', JSON.stringify([ce, ceBad]));

  const f0 = env.form({ force: true, inventory: NO_INV, now: () => 5 });
  const dims = Object.keys(f0.sections);
  const asyncDims = env.SECTION_ORDER.filter((id) => !env.SYNC_DIMS.includes(id));
  check('X-13 台账把维度收在一张表里且内置维度齐备（缺一个维度就是回到各说各话）；未刷新的异步维标 pending 并进留痕（面板据此说「尚未探测」而不是显示成「本机没有」）；同步维不靠刷新（选路与面板当场要读）',
    env.SECTION_ORDER.every((id) => dims.includes(id)) && dims.length === env.SECTION_ORDER.length && f0.schema === env.SCHEMA
    && asyncDims.every((id) => f0.sections[id] && f0.sections[id].state === 'pending' && f0.sections[id].data === null)
    && asyncDims.every((id) => f0.probed.some((p) => p.section === id && /未刷新/.test(String(p.detail))))
    && env.SYNC_DIMS.every((id) => f0.sections[id].state !== 'pending' && f0.sections[id].at === 5 && f0.sections[id].source === 'self'), dims.join(','));
  let probeCalls = 0;
  env.registerSection('x13-fake', { label: '假维度', probe: () => { probeCalls++; return { hit: true }; } });
  const fr = await env.refresh({ only: ['x13-fake'], force: true, inventory: NO_INV, now: () => 5 });
  const callsForced = probeCalls;
  await env.refresh({ only: ['x13-fake'], inventory: NO_INV, now: () => 5 });
  const callsCached = probeCalls;
  env.registerSection('x13-boom', { probe: () => { throw new Error('探针炸了'); } });
  const fb = await env.refresh({ only: ['x13-boom'], force: true, inventory: NO_INV, now: () => 5 });
  check('X-13 注册进来的维度进台账并带 label/source/at（采集归所有者、账本归表单：E1 的分工判据）；未到期不重探（面板轮询不得把子进程与网络查询变成常态开销）；探针抛错只记 error 一档（表单不得成为用户可见的失败原因，也不许拿旧数据顶）',
    !!fr.sections['x13-fake'] && fr.sections['x13-fake'].state === 'ok' && fr.sections['x13-fake'].source === 'registered'
    && fr.sections['x13-fake'].label === '假维度' && fr.sections['x13-fake'].data.hit === true && callsForced === 1 && callsCached === 1
    && fb.sections['x13-boom'].state === 'error' && /探针炸了/.test(fb.sections['x13-boom'].error)
    && fb.sections['x13-boom'].data === null && fb.schema === env.SCHEMA,
    JSON.stringify([fr.sections['x13-fake'], fb.sections['x13-boom']]));
  let rejMsg = null;
  try { env.registerSection('browsers', { probe: () => ({}) }); } catch (e) { rejMsg = String(e.message || e); }
  env.unregisterSection('x13-fake'); env.unregisterSection('x13-boom');
  check('X-13 反向：同步维拒接注册、注销即离开台账（两处写同一维度即两个口径）',
    !!rejMsg && /不接注册/.test(rejMsg) && env.form({ force: true, inventory: NO_INV }).sections['x13-fake'] === undefined, String(rejMsg));

  const dnsErr = (code) => eg.reachWith({ lookup: () => Promise.reject(Object.assign(new Error(code), { code })), connect: () => Promise.resolve(true) }, T, 443, 50);
  const connErr = (code) => eg.reachWith({ lookup: () => Promise.resolve('127.0.0.1'), connect: () => Promise.reject(Object.assign(new Error(code), { code })) }, T, 443, 50);
  const denied = { dns: await dnsErr('ENOTFOUND'), tcp: await connErr('ECONNREFUSED'), proto: await connErr('EPROTO'), cert: await connErr('ERR_TLS_CERT_ALTNAME_INVALID') };
  check('X-13 L0 分档：域名不存在=dns 段否证、连接被拒=tcp 段否证、TLS 协议错与证书错=tls 段否证（都算明确不通）',
    denied.dns.ok === false && denied.dns.stage === 'dns' && denied.tcp.ok === false && denied.tcp.stage === 'tcp'
    && denied.proto.ok === false && denied.proto.stage === 'tls' && denied.cert.ok === false && denied.cert.stage === 'tls', JSON.stringify(denied));
  const unknown = { again: await dnsErr('EAI_AGAIN'), timeout: await connErr('ETIMEDOUT'), reset: await connErr('ECONNRESET') };
  const okReach = await eg.reachWith({ lookup: () => Promise.resolve('127.0.0.1'), connect: () => Promise.resolve(true) }, T, 443, 50);
  check('X-13 L0 分档：解析服务器不响应 / 超时 / 半路 reset 一律判不出（砍能力要有否证，不能拿没答案当否证）；判定停在 TLS 完成（不发业务请求：能力判定不得变成内容依赖）',
    unknown.again.ok === null && unknown.again.stage === 'dns' && unknown.timeout.ok === null && unknown.reset.ok === null
    && okReach.ok === true && okReach.stage === 'tls' && !/http|GET|status/.test(String(okReach.detail)), JSON.stringify([unknown, okReach]));
  let lookCalls = 0;
  const spy = { lookup: () => { lookCalls++; return Promise.resolve('127.0.0.1'); }, connect: () => Promise.resolve(true) };
  const cached = await eg.reach(T, spy);
  const cached2 = await eg.reach(T, spy);
  check('X-13 同一主机在 TTL 内复用判定（一次登录动作不得反复摸网；复用的是原结论而不是重算）；hosts() 交出已判主机、invalidate 按主机作废（代理一改旧判定必须当场失效而不是等 TTL）',
    cached.ok === true && cached2.ok === true && cached2.cached === true && lookCalls === 1
    && eg.hosts().includes(T) && eg.invalidate(T) === 1 && eg.reachRead(T) === null, JSON.stringify([cached2, eg.hosts()]));

  const WIN_ON = '注册表项 HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings 的查询结果\r\n    ProxyEnable    REG_DWORD    0x1\r\n\r\n';
  const WIN_SV = '    ProxyServer    REG_SZ    127.0.0.1:7890\r\n\r\n';
  const winRun = (bin, args) => Promise.resolve(/ProxyEnable/.test(String(args[args.length - 1])) ? WIN_ON
    : /ProxyServer/.test(String(args[args.length - 1])) ? WIN_SV : '未找到指定的注册表项或值\r\n');
  const pw = await eg.proxyWin(winRun, note);
  const offRun = (bin, args) => Promise.resolve(/ProxyEnable/.test(String(args[args.length - 1])) ? '    ProxyEnable    REG_DWORD    0x0\r\n'
    : /ProxyServer/.test(String(args[args.length - 1])) ? WIN_SV : '未找到指定的注册表项或值\r\n');
  const one = await eg.proxyWin(offRun, note);
  const pacRun = (bin, args) => Promise.resolve(/AutoConfigURL/.test(String(args[args.length - 1])) ? '    AutoConfigURL    REG_SZ    http://pac/intranet.pac\r\n'
    : /ProxyEnable/.test(String(args[args.length - 1])) ? '    ProxyEnable    REG_DWORD    0x0\r\n' : '未找到指定的注册表项或值\r\n');
  const two = await eg.proxyWin(pacRun, note);
  check('X-13 linux 环境变量三态（有=on / 一个都没有=unknown：服务语境 import-environment 不全，判成没配就打死有代理的机器）；win32 代理解析只认值名与类型列（按英文提示语锚定 = 中国版机器读空，正是白窗口成因之一），ProxyServer 未启用=off、PAC 单独配也算在用',
    eg.proxyLinux({ HTTPS_PROXY: 'http://127.0.0.1:7890' }, note).state === 'on'
    && eg.proxyLinux({ https_proxy: 'http://127.0.0.1:7890' }, note).state === 'on'
    && eg.proxyLinux({}, note).state === 'unknown' && eg.proxyLinux({ https_proxy: '   ' }, note).state === 'unknown'
    && reg.regDwordOf(WIN_ON) === 1 && reg.regValueOf(WIN_SV) === '127.0.0.1:7890'
    && reg.regValueOf('未找到指定的注册表项或值\r\n') === null && reg.regValueOf(WIN_ON) === null
    && pw.state === 'on' && pw.server === '127.0.0.1:7890' && pw.source === 'registry:Internet Settings'
    && one.state === 'off' && one.server === '127.0.0.1:7890'
    && two.state === 'on' && two.pac === 'http://pac/intranet.pac' && two.server === null, JSON.stringify([pw, one, two]));
  const macOn = await eg.proxyMac(async () => 'HTTPEnable : 1\nHTTPProxy : 127.0.0.1\nHTTPPort : 8888\n', note);
  const macOff = await eg.proxyMac(async () => 'HTTPEnable : 0\nHTTPProxy : 127.0.0.1\n', note);
  const macNone = await eg.proxyMac(async () => '(The command could not load because of a sandbox.)\n', note);
  eg.invalidate();
  const syncCalls = eg.hosts().length;
  check('X-13 darwin 代理分档：开关为 1 才算在用、有开关但全 0 才是没配、读不出开关位置即 unknown；同步读数只取缓存、绝不触发系统查询（起子进程的是刷新那一步）；代理凭据不进表单也不进快照（脱敏住在入站口的同一把尺上）',
    macOn.state === 'on' && macOn.server === '127.0.0.1' && macOff.state === 'off' && macNone.state === 'unknown'
    && syncCalls === 0 && (eg.proxyRead() === null || eg.proxyRead().platform === process.platform)
    && red.maskProxyServer('http://usr:pwd@127.0.0.1:7890') === 'http://usr:***@127.0.0.1:7890'
    && red.maskProxyServer('127.0.0.1:7890') === '127.0.0.1:7890' && red.maskProxyServer(null) === null
    && red.maskProxySecrets('a=b http://u:p@h/x u2:p2@h2') === 'a=b http://u:***@h/x u2:***@h2', JSON.stringify([macOn, macOff, macNone]));

  const shf = await env.refresh({ only: ['shell'], force: true, inventory: NO_INV, now: () => 5 });
  const shRead = (shf.sections.shell || {}).data || {};
  check('X-13 壳上报维进台账且读侧落点唯一（available 必须等于 reason 是否 ok，读不出不能伪装成读到）',
    shf.sections.shell.state === 'ok' && shf.sections.shell.source === 'shell' && typeof shf.sections.shell.label === 'string'
    && shRead.path === sr.file() && shRead.available === (shRead.reason === 'ok')
    && (shRead.schema === null || shRead.schema === sr.SUPPORTED_SCHEMA)
    && Array.isArray(shRead.records) && typeof shRead.droppedRecords === 'number'
    && shf.probed.some((p) => p.section === 'shell' && /壳/.test(String(p.detail))), JSON.stringify(shf.sections.shell));

  const CH = { id: 'chrome', name: 'Chrome', bin: '/usr/bin/google-chrome', engine: 'chromium', sources: ['fixture'] };
  const inv = { platform: 'fixture', browsers: [CH], defaultId: null, defaultSource: null, probed: [{ source: 'fixture', detail: '1 项' }] };
  let allocated = 0;
  const spawnedIso = [];
  const isoOpen = (egress) => br.openBrowser(url, {
    platform: 'linux', inventory: inv, intent: 'isolated-login', egress, observeMs: 1,
    observe: async () => ({ stage: 'exit', code: 0, signal: null }),
    spawn: (bin, args) => { spawnedIso.push([bin, args]); return { fake: true }; },
    binAvailable: () => true, desktopAvailable: () => true, rmTree: () => {}, onExit: () => {},
    allocProfile: () => { allocated++; return '/P'; },
  });
  eg.invalidate();
  const blocked = await isoOpen(EG('off', rd(false, 'dns', 'ENOTFOUND')));
  const allocBlocked = allocated, spawnBlocked = spawnedIso.length;
  check('X-13 判定为必然空白时降档如实：并入既有窗口（via:browser）+ 不分配 profile + 证据带结论码与理由、文案说得出「空白页/代理」',
    blocked.ok === true && blocked.evidence.isolated === false && blocked.evidence.via === 'browser'
    && blocked.evidence.profile === null && allocBlocked === 0 && spawnBlocked === 1
    && blocked.evidence.egress.basis === 'cold-profile-blocked' && blocked.evidence.egress.viable === false
    && /空白页/.test(String(blocked.message)) && /代理/.test(String(blocked.message)), JSON.stringify([blocked.evidence, blocked.message]));
  check('X-13 降档全程零摸网零系统查询（判据吃注入的读数：CI 摸网会让同一条判据随宿主网络漂移）',
    eg.hosts().length === 0 && eg.proxyRead() === null, JSON.stringify(eg.hosts()));
  const undet = await isoOpen(EG('unknown', rd(false, 'dns', 'ENOTFOUND')));
  check('X-13 判不出即保持隔离档（用猜到的事实砍能力是被禁的形态：真机「弹了个空白窗」的另一半成因）',
    undet.ok === true && undet.evidence.isolated === true && undet.evidence.via === 'isolated'
    && undet.evidence.egress.viable === null && allocated === 1 && !/空白页/.test(String(undet.message)), JSON.stringify(undet.evidence));
  eg.invalidate();
}

async function x14() {
  const prevHome = process.env.DSH_SUPERVISOR_HOME;
  process.env.DSH_SUPERVISOR_HOME = path.join(TMP, 'x14-state');
  const INV14 = { platform: 'fixture', browsers: [], defaultId: null, defaultSource: null, probed: [] };
  const l0 = env.lastSnapshot({ now: () => 1000 });
  check('X-14 没落过盘要说成没写过（available:false + never-written + data/at/ageMs 皆 null，不含糊成读不出）',
    l0.available === false && l0.reason === 'never-written' && l0.data === null && l0.at === null
    && l0.ageMs === null && l0.path === env.snapshotPath(), JSON.stringify(l0));
  const f14 = env.form({ force: true, persist: true, inventory: INV14, now: () => 4242 });
  const l1 = env.lastSnapshot({ now: () => 9242 });
  check('X-14 落盘后读回整份上一拍表单与年龄（留痕读不回来就等于没留）',
    l1.available === true && l1.reason === 'ok' && l1.at === f14.at && l1.ageMs === 5000 && l1.path === env.snapshotPath()
    && !!l1.data && l1.data.schema === env.SCHEMA && l1.data.at === f14.at
    && env.SECTION_ORDER.every((id) => !!(l1.data.sections || {})[id]) && Array.isArray(l1.data.browsers),
    JSON.stringify({ available: l1.available, at: l1.at, ageMs: l1.ageMs, schema: l1.data && l1.data.schema }));
  fs.writeFileSync(env.snapshotPath(), '{"schema":' + (env.SCHEMA + 1) + ',"at":1}\n', { mode: 0o600 });
  const l2 = env.lastSnapshot();
  check('X-14 文件在但读不出/版本不符要单列一档（说成「没写过」会引着人去点刷新而不是去查文件）',
    l2.available === false && l2.reason === 'unreadable-or-schema-mismatch' && l2.data === null && fs.existsSync(l2.path),
    JSON.stringify({ reason: l2.reason }));
  if (prevHome === undefined) delete process.env.DSH_SUPERVISOR_HOME; else process.env.DSH_SUPERVISOR_HOME = prevHome;
}

function finish() {
  fs.rmSync(TMP, { recursive: true, force: true });
  const failed = results.filter((r) => !r);
  console.log(String.fromCharCode(10) + '结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
  process.exit(failed.length ? 1 : 0);
}

x10().catch((e) => check('X-10 异步判据自身未抛错', false, String((e && e.stack) || e)))
  .then(x13).catch((e) => check('X-13 异步判据自身未抛错', false, String((e && e.stack) || e)))
  .then(x14).catch((e) => check('X-14 异步判据自身未抛错', false, String((e && e.stack) || e)))
  .then(finish);
