'use strict';

const fs = require('node:fs');
const path = require('node:path');
// W6：环境变量名取 brand.js 单源（此前硬编 'DSH_UI_DIR'；brand.js 的 ENV_UI_DIR 曾零 JS 消费者 ⇒ 改名必漏这一处）。
const { ENV_UI_DIR } = require('../shared/brand');

function resolveUiDir() {
  const exeDir = (function () {
    try { return path.dirname(process.execPath); } catch { return __dirname; }
  })();
  const candidates = [
    process.env[ENV_UI_DIR] || null,
    path.join(__dirname, 'ui-react'),
    path.join(exeDir, 'ui-react'),
    path.join(exeDir, '..', 'ui-react'),
    path.join(__dirname, '..', '..', 'ui-react'),
    path.join(__dirname, '..', '..', 'ui', 'dist'),
  ].filter(Boolean);
  for (const dir of candidates) {
    try { if (fs.existsSync(path.join(dir, 'supervisor.html'))) return dir; } catch {}
  }
  return null;
}
const UI_DIR = resolveUiDir();
if (!UI_DIR) {
  console.error('[ui] 未找到新 React UI 产物（期望 supervisor.html；候选：ui-react / ui/dist / $' + ENV_UI_DIR + '）。');
  console.error('[ui] 请先执行 release/scripts/build-ui.sh（或开发态在 ui 目录 npm run build）。');
}
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};
// frame-ancestors 必须是壳 origin 白名单而非 'none'：'none' 连壳 iframe 一起拒，面板永远空白。
const FRAME_ANCESTORS = "tauri://localhost http://tauri.localhost https://tauri.localhost";
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors " + FRAME_ANCESTORS;

function serveStatic(res, file, corsOrigin) {
  if (!UI_DIR) {
    res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('UI not built — run release/scripts/build-ui.sh or set DSH_UI_DIR');
  }
  const full = path.join(UI_DIR, file);
  const rel = path.relative(UI_DIR, full);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    res.writeHead(403);
    return res.end('forbidden');
  }
  try {
    const content = fs.readFileSync(full);
    const ext = path.extname(file);
    const headers = {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Security-Policy': CSP,
      'X-Content-Type-Options': 'nosniff',
    };
    if (corsOrigin) { headers['Access-Control-Allow-Origin'] = corsOrigin; }
    headers['Cache-Control'] = 'no-store';
    res.writeHead(200, headers);
    res.end(content);
  } catch (e) {
    if (e.code === 'ENOENT') {
      res.writeHead(404);
      res.end('not found');
    } else {
      res.writeHead(500);
      res.end('internal error');
    }
  }
}

module.exports = { MIME, CSP, serveStatic };
