'use strict';

const fs = require("node:fs");
const pidlook = require("./pidlookup");

function readPidFile(f) {
  if (!f) return null;
  try {
    const t = fs.readFileSync(f, "utf8").trim();
    const n = Number.parseInt(t, 10);
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

function anchorsHit(pid, anchors) {
  if (!Array.isArray(anchors) || !anchors.length) return null;
  const cmd = pidlook.readCmdline(pid);
  if (!cmd) return null;
  return anchors.every((a) => a && cmd.indexOf(String(a)) !== -1);
}

function judge(identity) {
  const q = identity || {};
  const anchors = Array.isArray(q.anchors) ? q.anchors : [];
  const evidence = [];

  let pid = Number.isInteger(q.pid) && q.pid > 0 ? q.pid : null;
  let via = null;
  if (!pid) {
    pid = readPidFile(q.pidFile);
    if (pid) { via = "pidfile"; evidence.push("pid 来自 pid 文件"); }
  }

  const port = Number.isInteger(q.port) && q.port > 0 ? q.port : null;
  if (!pid && port) {
    pid = pidlook.findListeningPid(port);
    if (pid) { via = "port"; evidence.push("pid 来自端口监听者"); }
  }

  if (!pid) return { state: "dead", pid: null, via: null, evidence: ["无 pid 证据"] };

  const alive = pidlook.probeAlive(pid);
  if (alive === "dead") return { state: "dead", pid, via, evidence: evidence.concat(["pid 已退出"]) };
  if (alive === "unknown") return { state: "unknown", pid, via, evidence: evidence.concat(["pid 存活不可判定"]) };

  const cmd = pidlook.readCmdline(pid);
  if (anchors.length) {
    if (!cmd) return { state: "unknown", pid, via, evidence: evidence.concat(["cmdline 不可读，锚点无法校验"]) };
    const hit = anchorsHit(pid, anchors);
    if (hit === true) return { state: "ours", pid, via, evidence: evidence.concat(["锚点全部命中"]) };
    return { state: "foreign", pid, via, evidence: evidence.concat(["锚点未全部命中"]) };
  }

  if (cmd) {
    const known = pidlook.isDshCmdlineText(cmd);
    if (known) return { state: "ours", pid, via, evidence: evidence.concat(["cmdline 命中 dsh"]) };
    return { state: "foreign", pid, via, evidence: evidence.concat(["cmdline 非 dsh"]) };
  }
  return { state: "unknown", pid, via, evidence: evidence.concat(["cmdline 不可读，身份不可判定"]) };
}

module.exports = { judge, readPidFile, anchorsHit };