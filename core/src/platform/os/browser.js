'use strict';

// 三端同一「交给系统浏览器」出口。分层固定，每层只干一件事：
//   环境与选路（./environment.js）—— 本机实况表单（装了哪些浏览器、系统说不出默认时的候选次序、
//     图形会话、用户在本产品里选过谁）与「这次该用哪一个」的分发依据；
//   探测（./browser-inventory.js）—— 平台事实的唯一写法（环境表单消费它，本文件不直接查）；
//   执行（openBrowser，本文件）—— 按计划 spawn 一次并如实回报拿到的是什么档证据。
// 浏览器选择权在用户不在产品：本文件绝不点名任何浏览器，也不在探测失败时「挑一个试试」。

// 外部打开的唯一出口是 openBrowser，`intent` 决定用哪种形态：
//   'plain'          —— 普通打开（面板/CTL 的「在浏览器里打开」），用系统或用户选的浏览器、并入既有会话；
//   'isolated-login' —— 一键登录用的隔离窗口（独立 profile + 首启动静音参数 + 随机时区环境），
//                       并监视窗口关闭以便取消登录。窗口是否真能出内容还要过出网条件这一关
//                       （环境表单的 egress 维度判冷档案，判据不住在本文件）。
// 两种意图共用同一结果词汇 {ok, confirmed, handedOff, reason, error, message, url, evidence}：
//   调用方与面板只需认一套字段，不必各自解释 argv 结局，也不存在「登录那条路少判一层」的可能。
// 三档语义不得混为一谈（这是本能力的标准，也是历史上「面板显示成功而屏幕什么都没有」的病根）：
//   confirmed  —— 拿到了「调度器确实接收了该 URL」的证据：仅限本次启动确定拥有自己窗口的形态 0 退出
//   handedOff  —— 命令已交出且 spawn 没报错，但没有任何形态学证据说明窗口出现过
//   ok:false   —— 明确失败（非 0 退出/信号/error 事件/预检不过/选不出启动对象），必须带 reason 码与给用户的一句话。
// 「退出码何时算证据」只由 ownsItsWindow 一处决定，并且**双向**生效：不可信形态既不能凭 0 冒领 confirmed，
//   也不能凭非 0 判成失败。
// 能力档、图形会话、URL 合法性、启动对象可用性这些预检对两种意图一视同仁：过去隔离登录绕开了它们，
//   于是同一台机器上「面板能打开、一键登录不能」的分叉无从解释。
// 失败必须带得上屏幕的诊断：evidence 里有 pick/found/probed（分发依据、候选清单、每条来源的读数），
//   面板据此把「为什么没弹出来」摊成一行小字。旧形态只有一句「打开失败」，真机报障时无从定性。
// 结果需要等子进程的 error/exit 才能定，而 ENOENT 只在异步 error 事件里出现（见 binAvailable 注释），
//   故 openBrowser 是异步的：同步返回 true 的旧形态等于把「没报错」当「已打开」。

const path = require('node:path');
const spawnOS = require('./spawn');
// 图形会话可用性：只读 env/socket 判定（无 spawn），与本文件同层，故可直接依赖。
const desktop = require('./desktop');
// 能力档位表（纯数据）：外部打开支持哪些平台只由它的 openBrowser 位决定。
const CAPABILITY_PROFILES = require('./capability-profile');
const { resolveExecutable, isExecutableFile } = require('./exec-path');
// 环境表单：候选清单与分发依据的唯一来源（本文件不查注册表/LaunchServices/XDG，平台事实只写一次）。
const environment = require('./environment');
const detector = require('./browser-inventory');
const { engineOf } = detector;
// 临时 profile 的落盘与延迟清理（fs 只在 util 层出现：本文件不得 require node:fs）。
const { allocTempDir, removeTreeDeferred } = require('../util/fs');

/** 进 argv 前的唯一闸门：只校验协议为 http/https 的绝对 URL，不校验主机
 *  （两个意图传的都有：plain 传本机回环实例地址，isolated-login 传外部 OAuth 授权页）。 */
function isSafeHttpUrl(url) {
  try {
    const u = new URL(String(url));
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch { return false; }
}

/** 平台到「系统调度器」的命令（纯函数，不 spawn）。darwin 的 open / linux 的 xdg-open 是文档化调度器，
 *  退出码即「是否接收本次请求」。
 *  win32 返回 null：**没有可信的调度器形态**。系统 shell 的 URL 交付命令未文档化、退出码不携带信息
 *  （真机现场返回 1），且地址带查询串时会被当成路径去开文件资源管理器窗口；`cmd /c start` 是文档化路径，
 *  但 cmd.exe 把 & ^ " ( ) 当活性字符，与本文件「argv 永不裹 shell」的不变量冲突。
 *  所以 Windows 只能直启探测解析出的浏览器本体，解析不出来就显式报 no-launcher —— 宁可如实失败，
 *  也不冒「已交出」的风险（那是本能力历史上全部的假成功来源）。
 *  未知平台有意退化为 xdg-open：这里不宣称任何能力，只尽力尝试；autostart 相反 —— 它要向用户
 *  宣称服务管理器 kind，故未知平台必须显式 none。 */
function openCommand(platform, url) {
  const pl = platform || process.platform;
  if (pl === 'darwin') return { cmd: 'open', args: [url] };
  if (pl === 'win32') return null;
  return { cmd: 'xdg-open', args: [url] };
}

/** 支持外部打开的平台名单：单一来源 = 能力档位表里 openBrowser 为 true 的那些，
 *  本文件不得再写第二份平台判断（档位与行为分叉即「声明能开、实际乱试」）。 */
const SUPPORTED_OPEN_PLATFORMS = Object.keys(CAPABILITY_PROFILES).filter((k) => CAPABILITY_PROFILES[k].openBrowser === true);

/** 结果词汇的唯一构造点：三档语义在此定型，调用方与面板不再各自解释 argv/exit。
 *  @param {{ok:boolean, confirmed?:boolean, handedOff?:boolean, reason?:string|null,
 *           url?:string, evidence?:object}} p
 *  evidence 原样交出（调用方与面板靠它说明「这一档凭的是什么」），本函数不解释也不改写 argv 结局。 */
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
/** reason 码 -> 给用户的一句话（码是契约、文案是呈现；面板按码挂文案时不得改写码）。
 *  只有 ownsItsWindow 为真的形态才会走到 exit-nonzero/killed-by-signal，故这里可以断言窗口没出现。 */
const FAILURE_TEXT = {
  'unsafe-url': '地址不是 http(s) 绝对 URL，已拒绝交给浏览器',
  'no-launcher': '本机未探到可启动的浏览器（或所选浏览器已不可执行），请在面板的环境表单里确认，或手动打开该地址',
  'spawn-failed': '浏览器启动失败（系统拒绝了该命令）',
  'exit-nonzero': '系统拒绝了这个地址（启动命令非 0 退出），窗口未出现',
  'killed-by-signal': '浏览器启动命令被系统终止，窗口未出现',
  'no-desktop-session': '当前没有图形会话，无法调起浏览器',
  'unsupported-platform': '当前平台不在产品支持的桌面平台内，请手动打开该地址',
};

/** 退出码可信判据的唯一定义处：**本次启动是否确定拥有自己的窗口**。
 *  只有确定是新实例时，它的退出码才同时具备两种证明力：0 说明命令被接收、非 0 说明没接收。
 *  三种形态各有平台事实作根据，且都是平台语义而不是产品缺陷：
 *    via='isolated'（独立 profile 的登录窗口）：必为新实例，退出码双向都是事实；
 *    via='dispatcher'（darwin 的 open / linux 的 xdg-open）：非 0 即调度器明确拒了这次请求，0 即它确认接收，
 *      win32 无可信调度器（openCommand 返回 null），故该平台不成立；
 *    via='browser'（裸 URL 直启）：浏览器已在运行时本次进程只把地址转交给既有实例，
 *      退出码属于「转交动作」而不属于那个窗口 —— 两种不可信形态两个方向都不许进判决，一律只到 handedOff。 */
function ownsItsWindow(via, platform) {
  if (via === 'isolated') return true;
  if (via !== 'dispatcher') return false;
  return platform !== 'win32';
}

/** 拿到一个浏览器条目后的启动形态：两族引擎（chromium/firefox 派生系）的裸 URL 参数语义确定，直启本体，
 *  把「用哪个浏览器」留给用户在系统里设的默认值或在面板里选的偏好；argv 仍由我们自己拼（不经 shell）。
 *  other 引擎（Safari、打包器包装）在本平台有可信调度器时交回调度器 —— 裸 URL 参数语义不确定，
 *  但整条链路不得为此砍掉。win32 没有可信调度器，解析到的本体直启是唯一路（引擎不明也只是不可取证）。 */
function formOfBin(pl, b) {
  const engine = b && b.bin ? engineOf(b.bin) : 'other';
  return { engine, direct: !!b && (engine !== 'other' || pl === 'win32') };
}

/** 普通打开计划（纯函数，与 isolatedPlan 同族、同一分发依据输入）。
 *  @param {{inventory?:object, pick?:{browser:object|null, how:string}}} [opts] */
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

/** 隔离登录计划（纯函数，不 spawn、不摸文件系统）。
 *  输入与非隔离打开同一份候选清单与同一条分发链：登录窗口必须与「面板里点打开」用同一个浏览器，
 *  否则用户在偏好里选一次只对一半功能生效。
 *  拿不到独立 profile 或引擎无隔离方言时降为非隔离（isolated:false）：没有独立 profile 就并入既有实例，
 *  此时 onExit 恒误报「用户关了窗口」，故 watch 一并置 false —— 降级要降得如实，不冒充隔离。
 *  @param {{inventory?:object, pick?:object, profileDir?:string}} [opts] */
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
    // 方言只留「让它安静地开这一个窗」所必需的：独立 user-data-dir 本身就是隔离，且该目录用完即删
    // （deferredRemove），再叠一层无痕只是第二重冗余。外观参数（界面语言、窗口尺寸）一律不发：
    // 那是用户看得见的一面，不属于指纹面 —— 真机上中文 Windows 被弹出过一个法语界面的窗口。
    const args = ['--user-data-dir=' + o.profileDir,
      '--no-first-run', '--no-default-browser-check', '--disable-session-crashed-bubble'];
    // 独立 user-data-dir => 必为新实例进程，其 exit 即窗口关闭（onExit 语义成立）。
    return Object.assign(common, {
      bin: b.bin, args: [...baseArgs, ...args, url], via: 'isolated', isolated: true, watch: true,
      envKind: 'anti', label: 'chromium', exitIsEvidence: ownsItsWindow('isolated', pl),
    });
  }
  if (form.direct && form.engine === 'firefox' && o.profileDir) {
    // --no-remote + 专用 profile：不并入既有实例，新进程随窗口关闭而退出。
    // 同上不再叠 -private-window：专用 profile 已用完即删。
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

/** 观测一次 spawn 的真实结局（有界）：error/exit 先到者定局，窗口内两者都没到即「已移交、未证实」。
 *  超时句柄 unref：观测不得拖住进程退出。 */
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

/** 观测窗口：够长以捕获同步失败（ENOENT/权限）与秒退，够短以不占用面板的 15s 动作预算。 */
const OPEN_OBSERVE_MS = 1500;

/** 隔离登录窗口的随机化面：只随机用户看不见的那一面（时区）。
 *  这里曾有界面语言与窗口尺寸，真机上因此给中文 Windows 弹出一个法语界面的窗口 —— 看得见的一面归用户，
 *  不归指纹策略；且 LANG 在 Linux/macOS 上本就是 Chromium 的界面语言来源，把它留在环境里只是换平台复发。
 *  池子不参与任何能力判定。 */
const LOGIN_TZ_POOL = ['Asia/Shanghai', 'Asia/Seoul', 'Asia/Tokyo', 'Asia/Singapore', 'Europe/Berlin', 'Europe/London', 'Europe/Paris', 'America/New_York', 'America/Los_Angeles', 'Australia/Sydney'];

/** 隔离登录用的两套环境：anti=随机时区（隔离引擎用），sys=宿主环境补齐图形变量（降级路径用）。
 *  图形环境补齐只读 desktop.js 一处，不在这里再摸一遍 socket。 */
function loginEnv(rand) {
  const tz = LOGIN_TZ_POOL[Math.floor((typeof rand === 'function' ? rand() : Math.random()) * LOGIN_TZ_POOL.length)];
  const sysEnv = Object.assign({}, process.env, desktop.sessionEnv());
  return { sysEnv, antiEnv: Object.assign({}, sysEnv, { TZ: tz }) };
}

/** 探测清单摊成「一行能看完」的诊断，随每次打开的 evidence 交出：
 *  真机报障时这一行就是定档依据（探到几个、分发依据是哪一层、每条来源答了什么），不必再让人回去读代码。
 *  字段全为字符串/短数组，面板原样渲染。
 *  这里只放**清单与结论**，不放平台名与本次的 bin —— 那两个在 evidence 顶层已经有一份，
 *  同一件事在两处各写一遍，界面读到哪一处就成了运气，且第二处永远没人维护。
 *  第三参取 pickLauncher 的原样返回而不是清单字段：偏好（命中/已失效）是**这次分发的结论**，
 *  探测层不该知道自己被偏好越过，把它塞进 inventory 会让同一条事实在两处口径不同。 */
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

/** detachedIgnored 的无 env 变体：普通打开不注入反指纹环境，用宿主环境即可（隔离窗口才需要 antiEnv）。 */
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

/** spawn 前的可用性预检：绝对路径判执行位，裸名走 PATH 解析。
 *  必须在 spawn 前判：Node 的 ENOENT 是异步 error 事件，spawn 返回时已成功，
 *  事后挂 error 处理器只能吞掉它，改不了已经上报的 ok/bin。 */
function binAvailable(bin) {
  if (!bin) return false;
  if (bin.includes('/') || bin.includes('\\') || /^[A-Za-z]:[\\/]/.test(bin)) return isExecutableFile(bin);
  return resolveExecutable(bin) !== null;
}

/** 一次打开一行日志：本次实际的启动对象、argv 与三档结局。
 *  出口此前零日志——真机上「面板说已交出、屏幕上什么都没有」只能靠拍照取证，日志里连
 *  「启动的是哪个二进制、带了哪些参数」都查不到（同一台机器上还有别的路在开浏览器时，尤无法对照）。
 *  参数逐个去过查询串与片段：普通打开传的是带 ?token= 的本机地址，日志不是令牌的家。 */
function logOpen(lg, run, res) {
  const ev = res.evidence || {};
  const tier = res.ok ? (res.confirmed ? 'confirmed' : 'handedOff') : 'failed';
  // 只有真观测到退出才有退出可写：预检失败档的 evidence 里根本没有这两个键。
  const exit = ev.exitSignal ? ' signal=' + ev.exitSignal : (ev.exitCode === null || ev.exitCode === undefined ? '' : ' exit=' + ev.exitCode);
  const line = '[open] intent=' + run.intent + ' via=' + (ev.via || '-') + ' engine=' + (ev.engine || '-') +
    ' bin=' + (ev.bin || '-') + ' isolated=' + (ev.isolated === true) +
    ' argv=' + (run.args || []).map(redactArg).join(' ') +
    ' => ' + tier + (res.reason ? ' reason=' + res.reason : '') + exit + (ev.error ? ' error=' + ev.error : '');
  const fn = lg.info || lg.warn;
  if (typeof fn !== 'function') return;
  try { fn.call(lg, line); } catch { /* 日志绝不改变打开结局 */ }
}

/** 落日志/落 argv 摘要前的脱敏：截到 '?' 或 '#' 之前，保住 origin+path 供对照，丢掉查询串与片段。 */
function redactArg(a) {
  const s = String(a);
  let cut = -1;
  for (const ch of ['?', '#']) {
    const i = s.indexOf(ch);
    if (i >= 0 && (cut < 0 || i < cut)) cut = i;
  }
  return cut < 0 ? s : s.slice(0, cut) + '[trimmed]';
}

/** 外部打开的唯一出口：按意图把 http(s) URL 交给分发依据定出的浏览器（或该平台的文档化调度器），
 *  并如实回报证据档位。绝不宣称页面已加载 —— 最多说「命令 0 退出」。
 *  @param {string} url
 *  @param {{intent?:'plain'|'isolated-login', onExit?:Function, profileMs?:number,
 *           inventory?:object, resolveInventory?:Function, resolveDeps?:object, preference?:string|null,
 *           binAvailable?:Function, spawn?:Function, observe?:Function, observeMs?:number, setTimeout?:Function,
 *           platform?:string, desktopAvailable?:Function, allocProfile?:Function, rmTree?:Function,
 *           rand?:Function, now?:Function, egress?:object, logger?:{info?:Function,warn?:Function}}} [o]
 *    注入缝供行为测试：CI 机器不真起浏览器、不真查注册表、不真建临时目录，也不真摸网（egress 给定读数即不判网）。
 *    夹具与产品共用同一份输入（同源）。logger 缺省即不落日志（本层不 import 日志实现）。
 *  @returns {Promise<{ok, confirmed, handedOff, reason, error, message, url, evidence}>}
 *    evidence：{bin, engine, via, ownsWindow, isolated, profile, watch, exitCode, exitSignal, error,
 *              diagnostics, egress} —— isolated/profile 在这里而不是结果顶层：顶层字段集是三档词汇的契约，
 *    不得按意图增删；egress 是这次隔离判定的依据（null=本意图不判出网）。 */
async function openBrowser(url, o) {
  const opts = o || {};
  const pl = opts.platform || process.platform;
  const intent = opts.intent === 'isolated-login' ? 'isolated-login' : 'plain';
  // 本次执行的实际形态，只喂日志、不进结果契约：argv 与意图在 evidence 里没有读者，
  //   把它们塞进 evidence 就是造第二份事实。
  const run = { intent, args: null };
  // 每一档结局（含两条最早的预检失败）都从 out 出：结局在多处定档，日志若也在那多处各写一遍，
  //   漏写的那条路在界面上就又是「点了没反应、日志里查无此事」——本案要修的正是这个形态。
  const out = (p) => {
    const res = outcome(p);
    if (opts.logger) logOpen(opts.logger, run, res);
    return res;
  };
  if (!isSafeHttpUrl(url)) {
    return out({ ok: false, reason: 'unsafe-url', url: String(url || ''), evidence: null });
  }
  // 能力档位说「不支持」就在这里显式失败：openCommand 对未知平台仍会尽力试一次 xdg-open，
  // 但那是低层映射，不构成本产品对外宣称的能力（unknown 档位 openBrowser:false）。
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
  // 分发依据与「能不能隔离」在此定出一次，两种意图共用同一条链（旧形态是登录另走一条不查档的路）。
  const picked = opts.pick || environment.pickLauncher(pl, inv, pref);
  const form = formOfBin(pl, picked.browser);
  const canIsolate = intent === 'isolated-login' && form.direct
    && (form.engine === 'chromium' || form.engine === 'firefox');
  // 冷档案判定（出网条件维度）：能不能隔离不只取决于「探到了支持的浏览器」，还取决于「这个新档案
  //   有没有一条出网的路」。判据与取数都在环境表单（environment.checkEgress），本层只认结论：
  //   viable===false 是唯一降档条件（直连不通且系统没有在用代理 —— 那种窗口注定一片空白）；
  //   null（判不出）保持隔离，绝不拿猜到的事实砍能力。
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
  // 降档要说人话并留在结果里：用户在面板上看到的必须是「为什么没用隔离窗」，而不是静默少了隔离。
  const downgraded = cold && cold.viable === false;
  const downgradeText = downgraded
    ? ('本机直连 ' + cold.host + ' 不通且没有在用系统代理，隔离窗口会是空白页；已在现有浏览器窗口打开该地址'
      + '（登录完成后请手动清理账号，或先在系统里配好代理）')
    : null;
  // 预检不通过也要把已分配的目录收走：否则一次失败的登录就在临时目录里留一个孤儿（旧形态从不回收）。
  const deferredRemove = typeof opts.rmTree === 'function' ? opts.rmTree : removeTreeDeferred;
  const fail = (reason, patch) => {
    if (profile) deferredRemove(profile, 0);
    return out(Object.assign({ ok: false, reason, url, evidence }, patch));
  };
  // 无图形会话时任何启动命令都必败：两种意图同一条判据（判定同源 desktop.js）。
  // darwin/win32 由图形会话内的 LaunchAgent / schtasks ONLOGON 载入，无会话即无本进程。
  const desktopAvailable = typeof opts.desktopAvailable === 'function' ? opts.desktopAvailable : desktop.sessionAvailable;
  if (pl === 'linux' && !desktopAvailable()) {
    return fail('no-desktop-session');
  }
  // 定不出启动对象 = 显式失败并带诊断（旧形态是退到系统 shell 冒开，屏幕上什么都没有还说「已交出」）。
  if (!plan.bin) return fail('no-launcher');
  if (!avail(plan.bin)) return fail('no-launcher');
  // 要隔离却没拿到目录（临时目录分配失败）：如实报失败，绝不降级成「并入既有实例的假隔离登录」。
  //   注意判据是 isolate 而不是 canIsolate：出网条件判定降档时压根就不该分配目录，那条路是 plain。
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
  // 退出码进判决的唯一闸门，规则只在 openPlan/isolatedPlan/ownsItsWindow 一处写：不可信形态的退出码在两个
  //   方向上都不是证据 —— 据它判红会把已打开的页面报成失败，据它判绿会凭空宣称窗口出现过。
  //   判红与判绿必须同一条 `&&`，分两处写就会重新分叉。
  const exitDecides = seen.stage === 'exit' && plan.exitIsEvidence === true;
  if (exitDecides && (seen.code !== 0 || seen.signal)) {
    return out({
      ok: false, reason: seen.signal ? 'killed-by-signal' : 'exit-nonzero', url, evidence,
      error: FAILURE_TEXT[seen.signal ? 'killed-by-signal' : 'exit-nonzero'] + '（' + (seen.signal || seen.code) + '）',
    });
  }
  // 剩下的都是 ok：可信形态 0 退出算 confirmed；不可信形态（或窗口内仍存活、压根没有退出可言）
  //   只算 handedOff —— 命令确实交出去了，但窗口有无只有用户能判，故面板必须同时给出地址。
  //   降档时 message 换成分发依据给出的那句话说清「为什么没用隔离窗」，不得静默少一层隔离。
  return out({
    ok: true, confirmed: exitDecides, handedOff: !exitDecides, url, evidence,
    message: downgradeText || undefined,
  });
}

module.exports = {
  openBrowser, openCommand, openPlan, isolatedPlan, ownsItsWindow,
  observeSpawn, isSafeHttpUrl, binAvailable, launchDiagnostics, loginEnv,
  // 探测层的解析原语经此转出（唯一实现处在 ./browser-inventory.js）：门禁与消费方按同一出口取用，
  //   不在别处再写第二份平台解析。
  engineOf, detector,
};
