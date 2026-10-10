'use strict';

function buildCommand(ctx) {
  const { app, port, cachedBin, registry, launcher, execPath } = ctx || {};
  if (!app || !Array.isArray(app.command)) return { ok: false, error: '无效应用命令模板', cmd: [], registry: registry || null };
  if (cachedBin) {
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
  const mapped = app.command.map((t) => String(t).replace('{{port}}', String(port)));
  const cmd = mapped;
  const args = [...cmd.slice(1)];
  if (cmd[0] === 'npx' && registry) {
    const ri = args.findIndex((a) => a === '--registry');
    if (ri >= 0) args[ri + 1] = registry;
    else { args.unshift(registry); args.unshift('--registry'); }
  }
  if (cmd[0] === 'npx') {
    const l = launcher || { program: 'npx', args: [], source: 'path' };
    return { ok: true, cmd: [l.program, ...l.args, ...args], registry: registry || null };
  }
  return { ok: true, cmd: [cmd[0], ...args], registry: registry || null };
}

module.exports = { buildCommand };
