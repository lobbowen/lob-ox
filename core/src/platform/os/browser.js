'use strict';

const path = require('node:path');
const spawnOS = require('./spawn');
const desktop = require('./desktop');
const CAPABILITY_PROFILES = require('./capability-profile');
const { resolveExecutable, isExecutableFile } = require('./exec-path');
const environment = require('./environment');
const detector = require('./browser-inventory');
const { engineOf } = detector;
const { allocTempDir, removeTreeDeferred } = require('../util/fs');

function isSafeHttpUrl(url) {
  try {
    const u = new URL(String(url));
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch { return false; }
}

// darwin open / linux xdg-open 是文档化调度器（退出码=是否接收）；win32 无可信交付命令（cmd /c start 的活性字符违反「argv 永不裹 shell」），只能直启浏览器本体。
function openCommand(platform, url) {
  const pl = platform || process.platform;
  if (pl === 'darwin') return { cmd: 'open', args: [url] };
  if (pl === 'win32') return null;
  return { cmd: 'xdg-open', args: [url] };
}

const SUPPORTED_OPEN_PLATFORMS = Object.keys(CAPABILITY_PROFILES).filter((k) => CAPABILITY_PROFILES[k].openBrowser === true);

function outcome(p) {
  const ok = !!p.ok;
  const confirmed = ok && p.confirmed === true;
  const handedOff = ok && !confirmed;
  const reason = ok ? null : (p.reason || 'failed');
  return {
    ok, confirmed, handedOff, reason,
    error: ok ? null : (p.error || FAILURE_TEXT[reason] || ('打开失败（' + reason + '）')),
    message: ok ? (confirmed ? CONFIRMED_TEXT : (p.message || HANDEDOFF_TEXT)) : null,
    url: p.url === undefined ? null : p.url,
    evidence: p.evidence || null,
  };
}

const CONFIRMED_TEXT = '已在系统浏览器打开';
const HANDEDOFF_TEXT = '已把地址交给系统，但这次启动拿不到窗口是否出现的证据';
const FAILURE_TEXT = {
  'unsafe-url': '地址不是 http(s) 绝对 URL，已拒绝交给浏览器',
  'no-launcher': '本机未探到可启动的浏览器（或所选浏览器已不可执行），请在面板的环境表单里确认，或手动打开该地址',
  'spawn-failed': '浏览器启动失败（系统拒绝了该命令）',
  'exit-nonzero': '系统拒绝了这个地址（启动命令非 0 退出），窗口未出现',
  'killed-by-signal': '浏览器启动命令被系统终止，窗口未出现',
  'no-desktop-session': '当前没有图形会话，无法调起浏览器',
  'unsupported-platform': '当前平台不在产品支持的桌面平台内，请手动打开该地址',
};

function ownsItsWindow(via, platform) {
  if (via === 'isolated') return true;
  if (via !== 'dispatcher') return false;
  return platform !== 'win32';
}

function formOfBin(pl, b) {
  const engine = b && b.bin ? engineOf(b.bin) : 'other';
  return { engine, direct: !!b && (engine !== 'other' || pl === 'win32') };
}

function openPlan(platform, url, opts) {
  const o = opts || {};
  const pl = platform || process.platform;
  const picked = o.pick || environment.pickLauncher(pl, o.inventory, o.preference);
  const b = picked.browser;
  const form = formOfBin(pl, b);
  if (form.direct) {
    return { bin: b.bin, args: (b.baseArgs || []).concat([url]), engine: form.engine, via: 'browser',
             isolated: false, watch: false, envKind: 'sys', pick: picked.how, stale: picked.stale === true,
             exitIsEvidence: ownsItsWindow('browser', pl) };
  }
  const c = openCommand(pl, url);
  if (!c) return { bin: null, args: [url], engine: form.engine, via: 'none',
                   isolated: false, watch: false, envKind: 'sys', pick: picked.how, stale: picked.stale === true,
                   exitIsEvidence: false };
  return { bin: c.cmd, args: c.args, engine: 'other', via: 'dispatcher',
           isolated: false, watch: false, envKind: 'sys', pick: picked.how, stale: picked.stale === true,
           exitIsEvidence: ownsItsWindow('dispatcher', pl) };
}

function isolatedPlan(platform, url, opts) {
  const o = opts || {};
  const pl = platform || process.platform;
  const picked = o.pick || environment.pickLauncher(pl, o.inventory, o.preference);
  const b = picked.browser;
  const form = formOfBin(pl, b);
  const baseArgs = (b && b.baseArgs) || [];
  const common = { pick: picked.how, stale: picked.stale === true, engine: form.engine };
  const plain = (bin, label) => Object.assign(common, {
    bin, args: baseArgs.concat([url]), via: 'browser', isolated: false, watch: false, envKind: 'sys', label,
    exitIsEvidence: ownsItsWindow('browser', pl),
  });
  if (form.direct && form.engine === 'chromium' && o.profileDir) {
    const args = ['--user-data-dir=' + o.profileDir,
      '--no-first-run', '--no-default-browser-check', '--disable-session-crashed-bubble'];
    return Object.assign(common, {
      bin: b.bin, args: [...baseArgs, ...args, url], via: 'isolated', isolated: true, watch: true,
      envKind: 'anti', label: 'chromium', exitIsEvidence: ownsItsWindow('isolated', pl),
    });
  }
  if (form.direct && form.engine === 'firefox' && o.profileDir) {
    return Object.assign(common, {
      bin: b.bin, args: [...baseArgs, '--no-remote', '--profile', o.profileDir, url],
      via: 'isolated', isolated: true, watch: true, envKind: 'anti', label: 'firefox',
      exitIsEvidence: ownsItsWindow('isolated', pl),
    });
  }
  if (form.direct) return plain(b.bin, path.basename(b.bin));
  const c = openCommand(pl, url);
  if (!c) return Object.assign(common, {
    bin: null, args: [url], via: 'none', isolated: false, watch: false, envKind: 'sys', label: null,
    exitIsEvidence: false,
  });
  return Object.assign(common, {
    bin: c.cmd, args: c.args, via: 'dispatcher', isolated: false, watch: false, envKind: 'sys', label: c.cmd,
    exitIsEvidence: ownsItsWindow('dispatcher', pl),
  });
}

function observeSpawn(child, windowMs, setTimeoutFn) {
  return new Promise((resolve) => {
    let settled = false;
    let timer;
    const done = (r) => { if (settled) return; settled = true; clearTimeout(timer); resolve(r); };
    timer = (setTimeoutFn || setTimeout)(() => done({ stage: 'alive' }), windowMs);
    if (timer && timer.unref) timer.unref();
    child.on('error', (e) => done({ stage: 'error', code: (e && e.code) || String(e) }));
    child.on('exit', (code, signal) => done({ stage: 'exit', code, signal }));
  });
}

const OPEN_OBSERVE_MS = 1500;

const LOGIN_TZ_POOL = ['Asia/Shanghai', 'Asia/Seoul', 'Asia/Tokyo', 'Asia/Singapore', 'Europe/Berlin', 'Europe/London', 'Europe/Paris', 'America/New_York', 'America/Los_Angeles', 'Australia/Sydney'];

function loginEnv(rand) {
  const tz = LOGIN_TZ_POOL[Math.floor((typeof rand === 'function' ? rand() : Math.random()) * LOGIN_TZ_POOL.length)];
  const sysEnv = Object.assign({}, process.env, desktop.sessionEnv());
  return { sysEnv, antiEnv: Object.assign({}, sysEnv, { TZ: tz }) };
}

function launchDiagnostics(inv, plan, picked) {
  const found = ((inv && inv.browsers) || []).map((b) => ({
    name: b.name, engine: b.engine || engineOf(b.bin),
    via: (b.sources && b.sources.length ? b.sources : [b.source || 'unknown']).join('+'),
  }));
  const pk = picked || {};
  return {
    pick: pk.how || (plan && plan.pick) || 'none',
    default: inv && inv.defaultId ? { id: inv.defaultId, source: inv.defaultSource || null } : null,
    preference: pk.wanted ? { id: pk.wanted, matched: pk.stale !== true } : null,
    found,
    probed: (inv && inv.probed) || [],
  };
}

function _spawnDetachedIgnored(bin, args) {
  try {
    const p = spawnOS.detachedIgnored(bin, args);
    p.on('error', () => {});
    p.unref();
    return p;
  } catch { return null; }
}

function _spawnDetached(bin, args, env, onExit) {
  let child;
  try { child = spawnOS.detachedIgnored(bin, args, { env: env || process.env }); }
  catch { return null; }
  child.on('error', () => {});
  if (typeof onExit === 'function') child.on('exit', () => { try { onExit(); } catch {} });
  child.unref();
  return child;
}

function binAvailable(bin) {
  if (!bin) return false;
  if (bin.includes('/') || bin.includes('\\') || /^[A-Za-z]:[\\/]/.test(bin)) return isExecutableFile(bin);
  return resolveExecutable(bin) !== null;
}

function logOpen(lg, run, res) {
  const ev = res.evidence || {};
  const tier = res.ok ? (res.confirmed ? 'confirmed' : 'handedOff') : 'failed';
  const exit = ev.exitSignal ? ' signal=' + ev.exitSignal : (ev.exitCode === null || ev.exitCode === undefined ? '' : ' exit=' + ev.exitCode);
  const line = '[open] intent=' + run.intent + ' via=' + (ev.via || '-') + ' engine=' + (ev.engine || '-') +
    ' bin=' + (ev.bin || '-') + ' isolated=' + (ev.isolated === true) +
    ' argv=' + (run.args || []).map(redactArg).join(' ') +
    ' => ' + tier + (res.reason ? ' reason=' + res.reason : '') + exit + (ev.error ? ' error=' + ev.error : '');
  const fn = lg.info || lg.warn;
  if (typeof fn !== 'function') return;
  try { fn.call(lg, line); } catch {  }
}

function redactArg(a) {
  const s = String(a);
  let cut = -1;
  for (const ch of ['?', '#']) {
    const i = s.indexOf(ch);
    if (i >= 0 && (cut < 0 || i < cut)) cut = i;
  }
  return cut < 0 ? s : s.slice(0, cut) + '[trimmed]';
}

async function openBrowser(url, o) {
  const opts = o || {};
  const pl = opts.platform || process.platform;
  const intent = opts.intent === 'isolated-login' ? 'isolated-login' : 'plain';
  const run = { intent, args: null };
  const out = (p) => {
    const res = outcome(p);
    if (opts.logger) logOpen(opts.logger, run, res);
    return res;
  };
  if (!isSafeHttpUrl(url)) {
    return out({ ok: false, reason: 'unsafe-url', url: String(url || ''), evidence: null });
  }
  if (!SUPPORTED_OPEN_PLATFORMS.includes(pl)) {
    return out({ ok: false, reason: 'unsupported-platform', url, evidence: { platform: pl } });
  }
  const observeMs = opts.observeMs === undefined ? OPEN_OBSERVE_MS : opts.observeMs;
  const spawnWith = typeof opts.spawn === 'function' ? opts.spawn : (intent === 'isolated-login' ? _spawnDetached : _spawnDetachedIgnored);
  const avail = typeof opts.binAvailable === 'function' ? opts.binAvailable : binAvailable;
  const observe = typeof opts.observe === 'function' ? opts.observe : observeSpawn;
  const resolveInv = typeof opts.resolveInventory === 'function' ? opts.resolveInventory
    : ((platform, deps) => environment.browsers(Object.assign({ platform }, deps)));
  const inv = 'inventory' in opts ? opts.inventory : resolveInv(pl, opts.resolveDeps || {});
  const pref = 'preference' in opts ? opts.preference : undefined;
  const login = intent === 'isolated-login' ? loginEnv(opts.rand) : null;
  const picked = opts.pick || environment.pickLauncher(pl, inv, pref);
  const form = formOfBin(pl, picked.browser);
  const canIsolate = intent === 'isolated-login' && form.direct
    && (form.engine === 'chromium' || form.engine === 'firefox');
  const cold = canIsolate ? await environment.checkEgress(url, opts) : null;
  const isolate = canIsolate && (!cold || cold.viable !== false);
  let profile = null;
  if (isolate) {
    const alloc = typeof opts.allocProfile === 'function' ? opts.allocProfile : (() => allocTempDir('dsh-login-'));
    try { profile = opts.profileDir || alloc(); } catch { profile = null; }
  }
  const plan = intent === 'isolated-login'
    ? isolatedPlan(pl, url, { inventory: inv, pick: picked, profileDir: profile })
    : openPlan(pl, url, { inventory: inv, pick: picked });
  run.args = plan.args;
  const diagnostics = launchDiagnostics(inv, plan, picked);
  const evidence = {
    bin: plan.bin, engine: plan.engine, via: plan.via, ownsWindow: plan.exitIsEvidence === true,
    isolated: plan.isolated === true, profile: plan.isolated ? profile : null, watch: plan.watch === true,
    exitCode: null, exitSignal: null, error: null, diagnostics,
    egress: cold,
  };
  const downgraded = cold && cold.viable === false;
  const downgradeText = downgraded
    ? ('本机直连 ' + cold.host + ' 不通且没有在用系统代理，隔离窗口会是空白页；已在现有浏览器窗口打开该地址'
      + '（登录完成后请手动清理账号，或先在系统里配好代理）')
    : null;
  const deferredRemove = typeof opts.rmTree === 'function' ? opts.rmTree : removeTreeDeferred;
  const fail = (reason, patch) => {
    if (profile) deferredRemove(profile, 0);
    return out(Object.assign({ ok: false, reason, url, evidence }, patch));
  };
  const desktopAvailable = typeof opts.desktopAvailable === 'function' ? opts.desktopAvailable : desktop.sessionAvailable;
  if (pl === 'linux' && !desktopAvailable()) {
    return fail('no-desktop-session');
  }
  if (!plan.bin) return fail('no-launcher');
  if (!avail(plan.bin)) return fail('no-launcher');
  if (isolate && !profile) {
    evidence.error = '临时 profile 目录分配失败';
    return fail('spawn-failed');
  }
  let child;
  try {
    child = intent === 'isolated-login'
      ? spawnWith(plan.bin, plan.args, plan.envKind === 'anti' ? login.antiEnv : login.sysEnv, plan.watch ? opts.onExit : undefined)
      : spawnWith(plan.bin, plan.args);
  } catch (e) {
    evidence.error = (e && e.code) || String(e);
    return fail('spawn-failed');
  }
  if (!child) return fail('spawn-failed');
  if (evidence.profile) deferredRemove(evidence.profile, opts.profileMs === undefined ? 30 * 60 * 1000 : opts.profileMs);
  const seen = await observe(child, observeMs, opts.setTimeout);
  evidence.error = seen.stage === 'error' ? String(seen.code) : null;
  evidence.exitCode = seen.code === undefined ? null : seen.code;
  evidence.exitSignal = seen.signal === undefined ? null : seen.signal;
  if (seen.stage === 'error') return out({ ok: false, reason: 'spawn-failed', url, evidence });
  // 退出码只在「确定拥有自己的窗口」时是证据：判红与判绿必须同一条 &&，不可信形态两个方向都不成立。
  const exitDecides = seen.stage === 'exit' && plan.exitIsEvidence === true;
  if (exitDecides && (seen.code !== 0 || seen.signal)) {
    return out({
      ok: false, reason: seen.signal ? 'killed-by-signal' : 'exit-nonzero', url, evidence,
      error: FAILURE_TEXT[seen.signal ? 'killed-by-signal' : 'exit-nonzero'] + '（' + (seen.signal || seen.code) + '）',
    });
  }
  return out({
    ok: true, confirmed: exitDecides, handedOff: !exitDecides, url, evidence,
    message: downgradeText || undefined,
  });
}

module.exports = {
  openBrowser, openCommand, openPlan, isolatedPlan, ownsItsWindow,
  observeSpawn, isSafeHttpUrl, binAvailable, launchDiagnostics, loginEnv,
  engineOf, detector,
};
