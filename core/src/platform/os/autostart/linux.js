'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const ex = require('../../util/exec');
const { writeAtomic } = require('../../util/fs');

/** XDG 自启条目模板（内嵌，不依赖外置 desktop/ 目录——launcher 发行态不携带它）。
 *  @HOME@ 与 Exec/Icon 行在写入前按实际安装路径重写。 */
const GUI_AUTOSTART_TEMPLATE = [
  '[Desktop Entry]',
  'Type=Application',
  'Name=dsh-supervisor GUI',
  'Comment=登录时打开 DSH 监管面板',
  'Exec=@HOME@/.local/bin/dsh-supervisor-gui',
  'Icon=@HOME@/.local/share/icons/dsh-supervisor.png',
  'Terminal=false',
  'X-GNOME-Autostart-enabled=true',
  '',
].join('\n');

function guiFile() {
  return path.join(os.homedir(), '.config', 'autostart', 'dsh-supervisor-gui-autostart.desktop');
}

function status() {
  let unit = 'unknown';
  const en = ex.runDetail('systemctl', ['--user', 'is-enabled', 'dsh-supervisor.service']);
  unit = String(en.stdout || en.stderr || 'disabled').trim() || 'disabled';
  return { kind: 'systemd', unit, on: unit === 'enabled', gui: fs.existsSync(guiFile()) };
}

function setAutostart(on, deps) {
  const errors = [];
  { const r = ex.runDetail('systemctl', ['--user', 'daemon-reload']);
    if (!r.ok) errors.push('daemon-reload: ' + (r.error || '执行失败')); }
  { const r = ex.runDetail('systemctl', ['--user', on ? 'enable' : 'disable', 'dsh-supervisor.service']);
    if (!r.ok) errors.push((on ? 'enable' : 'disable') + ': ' + (r.error || '执行失败')); }
  { const r = ex.runDetail('loginctl', [on ? 'enable-linger' : 'disable-linger', os.userInfo().username]);
    if (!r.ok && on) errors.push('enable-linger: ' + (r.error || '执行失败')); }
  const g = setGuiAutostart(on, deps);
  if (!g.ok) errors.push(g.error);
  return { ok: errors.length === 0, errors, ...status() };
}

/** GUI（桌面壳）登录自启 —— XDG autostart .desktop（Exec 按实际安装解析）。 */
function setGuiAutostart(on, deps) {
  try {
    const file = guiFile();
    if (on) {
      let entry = GUI_AUTOSTART_TEMPLATE;
      // Exec 必须指向解析出的真实路径：deb 把可执行装在 /usr/bin，模板写死的 ~/.local/bin
      // 会让用安装包的用户登录时 Exec 指向不存在的文件。
      entry = entry.split('@HOME@').join(os.homedir());
      const guiBin = deps.guiCommand();
      const oldExec = os.homedir() + '/.local/bin/dsh-supervisor-gui';
      if (entry.includes(oldExec)) entry = entry.split(oldExec).join(guiBin);
      // Desktop Entry 规范的 Exec 是空格分词的：路径含空格时必须引号界定；值内双引号/反斜杠要转义，
      // 且字面 % 必须写成 %%（否则被当字段码，自启静默失效）。
      const execQuote = (p) => '"' + String(p)
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/%/g, '%%') + '"';
      entry = entry.replace(/^Exec=.*$/m, 'Exec=' + execQuote(guiBin));
      // Icon 同样按实际安装解析（deb 装到 /usr/share，本地装到 ~/.local/share）
      const iconCandidates = [
        path.join(os.homedir(), '.local', 'share', 'icons', 'dsh-supervisor.png'),
        '/usr/share/icons/hicolor/256x256/apps/dsh-supervisor.png',
        '/usr/share/pixmaps/dsh-supervisor.png',
      ];
      const icon = iconCandidates.find((c) => { try { return fs.statSync(c).isFile(); } catch { return false; } });
      if (icon) entry = entry.split(/^Icon=.*$/m).join('Icon=' + icon);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      writeAtomic(file, entry, { mode: 0o644 });
    } else { try { fs.unlinkSync(file); } catch {} }
    return { ok: true, enabled: !!on, exec: deps.guiCommand() };
  } catch (e) { return { ok: false, error: e.message }; }
}

module.exports = { GUI_AUTOSTART_TEMPLATE, guiFile, status, setAutostart, setGuiAutostart };
