'use strict';

const spawnOS = require('./spawn');

function appleScriptString(s) {
  return JSON.stringify(String(s));
}

function powerShellString(s) {
  return "'" + String(s).replace(/'/g, "''") + "'";
}

function notifyCommand(platform, title, body) {
  const pl = platform || process.platform;
  const t = String(title == null ? '' : title);
  const b = String(body == null ? '' : body);
  if (pl === 'linux') {
    return { cmd: 'notify-send', args: ['-a', 'lobox', t, b] };
  }
  if (pl === 'darwin') {
    const script = 'display notification ' + appleScriptString(b) + ' with title ' + appleScriptString(t);
    return { cmd: 'osascript', args: ['-e', script] };
  }
  if (pl === 'win32') {
    const ps = [
      '[reflection.assembly]::loadwithpartialname("System.Windows.Forms") | Out-Null',
      '[reflection.assembly]::loadwithpartialname("System.Drawing") | Out-Null',
      '$n = New-Object System.Windows.Forms.NotifyIcon',
      '$n.Icon = [System.Drawing.SystemIcons]::Information',
      '$n.Visible = $true',
      '$n.ShowBalloonTip(4000, ' + powerShellString(t) + ', ' + powerShellString(b) + ', [System.Windows.Forms.ToolTipIcon]::None)',
      'Start-Sleep -Milliseconds 4200',
      '$n.Dispose(); $n.Visible = $false',
    ].join('; ');
    return { cmd: 'powershell', args: ['-NoProfile', '-NonInteractive', '-Command', ps] };
  }
  return null;
}

function notify(title, body, onError) {
  try {
    const plan = notifyCommand(process.platform, title, body);
    if (!plan) return false;
    const c = spawnOS.detachedIgnored(plan.cmd, plan.args);
    c.on('error', () => { if (onError) onError(); });
    c.unref();
    return true;
  } catch { if (onError) onError(); return false; }
}

module.exports = { notify, notifyCommand, appleScriptString, powerShellString };
