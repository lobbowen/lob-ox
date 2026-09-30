'use strict';

// api/static —— UI 产物目录解析 + MIME + CSP + 静态托管。
//
// 本文件是安全面（CSP / nosniff / 路径穿越防护 / 禁止缓存），语义不得"顺手优化"；
// 断言见 test/api-security-test.js（CSP 指令级、nosniff、编码穿越 404/403）；
//  原 test/core-test.js 已于 2026-10-01 随门禁清理拆分/删除。

const fs = require('node:fs');
const path = require('node:path');

// 前端静态资源目录解析：打包后 __dirname 不再等于源码目录，故多候选探测覆盖全部发行形态：
// $DSH_UI_DIR 显式注入 / core.cjs 或可执行文件旁的 ui-react / repo 根 ui-react / 开发态 ui/dist。
// 命中 supervisor.html 即用，候选顺序即优先级。
function resolveUiDir() {
  const exeDir = (function () {
    try { return path.dirname(process.execPath); } catch { return __dirname; }
  })();
  const candidates = [
    process.env.DSH_UI_DIR || null,
    path.join(__dirname, 'ui-react'),         // launcher 统一形态（core.cjs 旁）
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
  console.error('[ui] 未找到新 React UI 产物（期望 supervisor.html；候选：ui-react / ui/dist / $DSH_UI_DIR）。');
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
// frame-ancestors 必须是**壳 origin 白名单**而不是 'none'：桌面壳以内容 iframe 承载本面板
//  （壳主帧 origin 与 api/security.js 的 isShellOrigin 同一集合），'none' 连它一起拒 -> 面板永远
//  空白。白名单不外溢：不放 'self'（面板自身不做同源嵌套框架），第三方页仍全禁——面板写操作是
//  同源 fetch 而 originAllowed 对同源 iframe 同样放行，一次单击即可开公网暴露/停实例，所以框架
//  禁令仍是 Origin 闸之外的唯一防线。浏览器直接访问面板属顶层导航，不受本指令约束。
const FRAME_ANCESTORS = "tauri://localhost http://tauri.localhost https://tauri.localhost";
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors " + FRAME_ANCESTORS;

function serveStatic(res, file, corsOrigin) {
  if (!UI_DIR) {
    // UI 缺失（未构建/部署裁剪）：显式 503，绝不抛 TypeError 触发守卫自杀重启
    res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('UI not built — run release/scripts/build-ui.sh or set DSH_UI_DIR');
  }
  const full = path.join(UI_DIR, file);
  // 路径穿越防护：relative 必须落在 UI_DIR 内部
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
    // 面板资源一律 no-store：前端改动立即生效，避免浏览器缓存旧版导致渲染异常。
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
