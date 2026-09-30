'use strict';

// 命令拼装：纯函数，零 IO / 零 require。缓存优先（npx 包缓存命中 -> 直接 node <bin>，零解析零下载）；
// 未命中走注入的 npx 成对启动形态——win32 无 shell spawn .cmd 垫片必 EINVAL，形态解析归
// platform/os/npx-forms#npxLauncher，本模块只消费不解析。
// 凭证不在本模块处理：{{key}} / --api-key 的剔除是调用方（provider）的凭证纪律，本模块绝不持有密钥。

/** 由 app 模板 + 端口构造 spawn argv。ctx = { app, port, cachedBin, registry, launcher, execPath }，
 *  launcher = platform 解析出的成对启动形态；返回 { ok, cmd, registry }。 */
function buildCommand(ctx) {
  const { app, port, cachedBin, registry, launcher, execPath } = ctx || {};
  if (!app || !Array.isArray(app.command)) return { ok: false, error: '无效应用命令模板', cmd: [], registry: registry || null };
  if (cachedBin) {
    // 标准参数统一注入（host/port）——api-key 绝不写入 cmdline
    const args = ['--host', '127.0.0.1', '--port', String(port)];
    const STANDARD = new Set(['--host', '--port', '--api-key', 'npx', '--yes']);
    const extra = [];
    const cmdList = app.command;
    for (let i = 0; i < cmdList.length; i++) {
      const t = String(cmdList[i]);
      if (STANDARD.has(t) || t.includes('{{') || (app.pkg && t === app.pkg)) continue;
      if (t === '127.0.0.1' || t === String(port)) continue;
      if (String(t).startsWith('--registry') || t === '--registry') continue;
      if (i > 0 && STANDARD.has(String(cmdList[i - 1]))) continue;
      extra.push(t);
    }
    return { ok: true, cmd: [execPath, cachedBin, ...extra, ...args], registry: registry || null };
  }
  // fallback：npx 形态拉起（首次安装/缓存丢失）——只替换 {{port}}；{{key}}/--api-key 交由调用方剔除
  const mapped = app.command.map((t) => String(t).replace('{{port}}', String(port)));
  const cmd = mapped;
  const args = [...cmd.slice(1)];
  if (cmd[0] === 'npx' && registry) {
    const ri = args.findIndex((a) => a === '--registry');
    if (ri >= 0) args[ri + 1] = registry;
    else { args.unshift(registry); args.unshift('--registry'); }
  }
  if (cmd[0] === 'npx') {
    // 成对形态优先：node-direct 时 program=node、args 前置 npx-cli.js 路径。
    const l = launcher || { program: 'npx', args: [], source: 'path' };
    return { ok: true, cmd: [l.program, ...l.args, ...args], registry: registry || null };
  }
  return { ok: true, cmd: [cmd[0], ...args], registry: registry || null };
}

module.exports = { buildCommand };
