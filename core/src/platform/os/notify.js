'use strict';

// 平台化桌面通知：三端同一 notify(title, body) 最佳努力接口（失败静默，仅可选 onError 回调可感知）。
// Linux notify-send；macOS osascript display notification；Windows PowerShell NotifyIcon 气泡（无需第三方模块）。

// SSOT：异步 spawn 统一封装（固定 windowsHide:true）。
const spawnOS = require('./spawn');

/** AppleScript 字符串字面量转义（与 JSON 同用反斜杠，JSON.stringify 恰好等价）。 */
function appleScriptString(s) {
  return JSON.stringify(String(s));
}

/** PowerShell 单引号字符串字面量：' 双写即唯一转义规则；$ 与反引号在单引号串内是字面字符。
 *  不得用双引号串：body 有 err.message 通路，$(...) 会被 PowerShell 子表达式插值执行，是命令注入面。
 *  AppleScript/JSON 用反斜杠转义，规则不同，必须分开实现。 */
function powerShellString(s) {
  return "'" + String(s).replace(/'/g, "''") + "'";
}

/** 平台到通知命令（纯函数，可穷举；不 spawn）。命令构造/转义是跨平台 bug 的藏身处，
 *  故从 spawn 中抽出以便在任意宿主验证。
 *  @returns {{cmd:string,args:string[]}|null} null = 该平台无通知机制 */
function notifyCommand(platform, title, body) {
  const pl = platform || process.platform;
  const t = String(title == null ? '' : title);
  const b = String(body == null ? '' : body);
  if (pl === 'linux') {
    // argv 直传，无 shell -> 无转义问题
    return { cmd: 'notify-send', args: ['-a', 'dsh-supervisor', t, b] };
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

/** 桌面通知（最佳努力）：关键事件即使面板没开也能触达用户。
 *  @returns {boolean} 是否成功派发（环境缺失/平台不支持返回 false）。 */
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
