'use strict';

// launchctl enable/disable 会持久化进 launchd 覆盖库（这才是关自启真正生效的机制；删 plist 会被壳重建）；守卫 plist 归属见 autostart/index.js。

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const ex = require('../../util/exec');
const { writeAtomic } = require('../../util/fs');
const { shellDir } = require('../../service/state-root');

const GUARD_LABEL = 'com.dsh.supervisor';
const GUI_LABEL = 'com.dsh.supervisor.gui';
const MAC_T = 8000;

function laFile(name) {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', name + '.plist');
}

function macUid() { return (typeof process.getuid === 'function') ? process.getuid() : 0; }

function macLoaded(label) {
  try {
    return ex.runDetail('launchctl', ['print', 'gui/' + macUid() + '/' + label], { stdio: 'ignore', timeoutMs: MAC_T }).ok;
  } catch { return false; }
}
function macSetEnabled(label, on) {
  try { return ex.runDetail('launchctl', [on ? 'enable' : 'disable', 'gui/' + macUid() + '/' + label], { stdio: 'ignore', timeoutMs: MAC_T }).ok; }
  catch { return false; }
}
function macBootstrap(file) {
  try { return ex.runDetail('launchctl', ['bootstrap', 'gui/' + macUid(), file], { stdio: 'ignore', timeoutMs: MAC_T }).ok; }
  catch { return false; }
}
function macBootout(label) {
  try { return ex.runDetail('launchctl', ['bootout', 'gui/' + macUid() + '/' + label], { stdio: 'ignore', timeoutMs: MAC_T }).ok; }
  catch { return false; }
}

function xmlEscape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function macGuiPlist(guiExe) {
  const log = path.join(shellDir(), 'gui-stdio.log');
  return '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n'
    + '<plist version="1.0"><dict>\n'
    + '  <key>Label</key><string>' + xmlEscape(GUI_LABEL) + '</string>\n'
    + '  <key>ProgramArguments</key>\n'
    + '  <array><string>' + xmlEscape(guiExe) + '</string></array>\n'
    + '  <key>RunAtLoad</key><true/>\n'
    + '  <key>LimitLoadToSessionType</key><string>Aqua</string>\n'
    + '  <key>ProcessType</key><string>Interactive</string>\n'
    + '  <key>StandardOutPath</key><string>' + xmlEscape(log) + '</string>\n'
    + '  <key>StandardErrorPath</key><string>' + xmlEscape(log) + '</string>\n'
    + '</dict></plist>\n';
}

function status() {
  const guardDefined = fs.existsSync(laFile(GUARD_LABEL));
  const guardLoaded = guardDefined && macLoaded(GUARD_LABEL);
  const guiFile_ = laFile(GUI_LABEL);
  const guiDefined = fs.existsSync(guiFile_);
  return {
    kind: 'launchagent',
    on: guardLoaded,
    gui: guiDefined && macLoaded(GUI_LABEL),
    guardDefined,
    guardLabel: GUARD_LABEL,
    guiLabel: GUI_LABEL,
  };
}

function setAutostart(on, deps) {
  const errors = [];
  try {
    const file = laFile(GUARD_LABEL);
    if (on) {
      if (!fs.existsSync(file)) {
        errors.push('守卫服务定义缺失（' + file + '）：定义由桌面壳建立，请先启动一次桌面壳');
      } else {
        if (!macSetEnabled(GUARD_LABEL, true)) errors.push('launchctl enable 失败');
        if (!macLoaded(GUARD_LABEL) && !macBootstrap(file)) errors.push('launchctl bootstrap 失败');
      }
    } else {
      if (macLoaded(GUARD_LABEL)) macBootout(GUARD_LABEL);
      if (!macSetEnabled(GUARD_LABEL, false)) errors.push('launchctl disable 失败');
    }
  } catch (e) { errors.push('launchagent: ' + e.message); }
  const g = setGuiAutostart(on, deps);
  if (!g.ok) errors.push(g.error || 'GUI 自启设置失败');
  return { ok: errors.length === 0, errors, ...status() };
}

function setGuiAutostart(on, deps) {
  try {
    const file = laFile(GUI_LABEL);
    if (on) {
      const gui = deps.guiCommand();
      if (!gui || !fs.existsSync(gui)) {
        return { ok: false, platform: 'darwin', enabled: false,
                 error: '未定位到桌面壳可执行文件，无法配置自启：' + gui };
      }
      fs.mkdirSync(path.dirname(file), { recursive: true });
      writeAtomic(file, macGuiPlist(gui), { mode: 0o644 });
      macSetEnabled(GUI_LABEL, true);
      const loaded = macLoaded(GUI_LABEL) || macBootstrap(file);
      return { ok: true, platform: 'darwin', enabled: true, via: 'launchagent',
               label: GUI_LABEL, file, exe: gui, loaded };
    }
    if (macLoaded(GUI_LABEL)) macBootout(GUI_LABEL);
    macSetEnabled(GUI_LABEL, false);
    try { fs.unlinkSync(file); } catch {}
    return { ok: true, platform: 'darwin', enabled: false, via: 'launchagent', label: GUI_LABEL };
  } catch (e) {
    return { ok: false, platform: 'darwin', enabled: false, error: e.message };
  }
}

module.exports = {
  GUARD_LABEL, GUI_LABEL, laFile, xmlEscape, macGuiPlist,
  macLoaded, macSetEnabled, macBootstrap, macBootout,
  status, setAutostart, setGuiAutostart,
};
