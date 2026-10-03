'use strict';

const pidlook = require('../os/pidlookup');
const probeModule = require('../util/probe');

function isPortListening(host, port, timeoutMs) {
  return probeModule.portListening(host, port, timeoutMs || 1000);
}

// 端口视角（谁在监听这个端口）：pid + 该 pid 的 cmdline 是否像 DSH。
// cmdline 只读一次：readCmdline 在 win32 会落到 wmic/powershell（每次都是一次子进程）。
function pidState(port) {
  const pid = pidlook.findListeningPid(port);
  if (pid === null) return { pid: null, isDsh: false, cmdlineKnown: false };
  const cmd = pidlook.readCmdline(pid);
  if (!cmd) return { pid, isDsh: false, cmdlineKnown: false };
  return { pid, isDsh: pidlook.isDshCmdlineText(cmd), cmdlineKnown: true };
}

// 端口视角（平台无关）：只回答「谁在监听这个端口」。它不是存活判据——
// 主实例存活由 child 的 exit/close 事件 + 平台 pidlookup 判定（见 app/main/*）。
async function probe(host, port, opts) {
  const o = opts || {};
  const listening = await isPortListening(host, port, o.portTimeoutMs || 1200);
  if (!listening) return { up: false, pid: null, isDsh: false };
  const { pid, isDsh } = pidState(port);
  return { up: pid !== null, pid, isDsh };
}

// 受管实例存活判据（H-02）：拆开「端口被占」与「本实例在跑」两件事。
//   portTaken = 端口上有监听者（无论它是谁）—— 只喂启动前占用守卫（lifecycle.js start）。
//   running   = 监听者身份匹配 —— 这才是存活，喂相位迁移 / 资源采样 / 重启决策。
//
// 身份判据用**实例自己的启动锚点**（启动命令入口 + `--port <port>`），不是产品名：
//   * 入口允许 dsh / dsh.js / lobox / lobox.js（api/domains/instances.js 的 DSH_ENTRY 与 BRAND.CLI_NAME）
//     ⇒ 按 /dsh/i 判会把合法 lobox 入口的实例判成「没在跑」⇒ 守卫进入重启循环。
//   * 反过来，仅含 dsh 字样的无关进程（/opt/dsh-tools/x.js）也不会被锚点认成实例 ⇒ 两头都干净。
//   * 与 platform/os/portable.js#matchesAnchors 同一套做法：归属判定吃锚点，不猜产品名。
// 锚点由调用方给（lifecycle 传 sandbox.launchCtx 的 anchors）。缺锚点时退回宽松判据并记 identityUnknown：
//   宁判「在跑」也不误重启健康实例 —— 误重启会打断正在运行的实例，代价高于漏判。
// 锚点判定用**合取**（入口锚 ∧ 端口锚都得命中），不用析取：
//   只判端口锚会被 `/opt/dsh-tools/x.js --port <同端口>` 这类无关进程命中 —— 端口是共享事实，不是身份。
//   与 portable.js#matchesAnchors 的析取不同（那是「找我们的进程去杀」，宁可少杀）
//   ⇒ 这里是「认不认它是本实例」，必须两头都对上：误认会让守卫不管，并按外来 pid 采样资源。
function matchesAnchors(pid, anchors) {
  if (!pid || !Array.isArray(anchors) || !anchors.length) return false;
  const cmd = pidlook.readCmdline(pid);
  if (!cmd) return false;
  return anchors.every((a) => a && cmd.indexOf(String(a)) !== -1);
}

function probeInstance(inst, opts) {
  const o = opts || {};
  const port = inst && inst.port;
  const idle = { pid: null, running: false, isDsh: false, portTaken: false, identityUnknown: false, phase: 'STOPPED' };
  if (!Number.isInteger(port) || port <= 0) return idle;
  const pid = pidlook.findListeningPid(port);
  if (pid === null) return idle;
  const cmd = pidlook.readCmdline(pid);
  const cmdlineKnown = !!cmd;
  const isDsh = cmdlineKnown ? pidlook.isDshCmdlineText(cmd) : false;
  const anchors = Array.isArray(o.anchors) ? o.anchors : [];
  let running;
  let identityUnknown = false;
  if (anchors.length && cmdlineKnown) {
    running = matchesAnchors(pid, anchors);
  } else if (anchors.length) {
    // 有锚点但 cmdline 读不到 ⇒ 无从比对 ⇒ 与「无锚点且读不到」同解：判「在跑」+ 标记未知。
    running = true;
    identityUnknown = true;
  } else if (cmdlineKnown) {
    // 无锚点：沿用「听者像不像 DSH」这条宽松判据（H-02 之前的行为），不收紧以免误重启健康实例。
    running = isDsh;
  } else {
    // 无锚点且 cmdline 读不到：身份无从判定 ⇒ 判「在跑」并标记未知（误重启比漏判贵）。
    running = true;
    identityUnknown = true;
  }
  return { pid, running, isDsh, portTaken: true, identityUnknown, phase: running ? 'RUNNING' : 'STOPPED' };
}

module.exports = { probe, probeInstance, isPortListening, matchesAnchors };
