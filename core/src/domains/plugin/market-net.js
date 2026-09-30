'use strict';

// 插件市场 HTTP JSON/文本原语：体积上限 + 非 2xx 直接失败 + 重定向最多 5 跳 + 目标协议校验。
// 重定向必须校验协议：file:// 会让 http.get 同步抛 ERR_INVALID_PROTOCOL，且此处位于响应回调内，
// 会逃逸为进程级 uncaughtException（registry 可配任意 https，302 可落到第三方镜像）。
// 注意：test/round8-fixes-test.js J-g 按源码断言本文件保留两条协议校验。

const http = require('node:http');
const https = require('node:https');

/** 简易 JSON GET（加固：响应体上限 5MB / 非 2xx 直接失败 / 重定向最多 5 跳）。 */
function getJson(url, timeoutMs = 10000, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const options = { headers: { 'User-Agent': 'dsh-supervisor-market', 'Accept': 'application/json' } };
    const req = mod.get(url, options, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        if (redirectsLeft <= 0) return reject(new Error('too many redirects from ' + url));
        const next = String(res.headers.location);
        if (!/^https?:\/\//i.test(next)) return reject(new Error('重定向到不支持的协议: ' + next.slice(0, 64)));
        return getJson(next, timeoutMs, redirectsLeft - 1).then(resolve, reject);
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        return reject(new Error('HTTP ' + res.statusCode + ' from ' + url));
      }
      let b = '';
      let over = false;
      const MAX_BYTES = 5 * 1024 * 1024;
      res.on('data', (c) => {
        if (over) return;
        b += c;
        if (b.length > MAX_BYTES) { over = true; b = ''; try { req.destroy(); } catch {} reject(new Error('response too large from ' + url)); }
      });
      res.on('end', () => {
        if (over) return;
        try { resolve(JSON.parse(b)); } catch (e) { reject(new Error('bad json from ' + url)); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout ' + url)));
    req.on('error', reject);
    req.setTimeout(timeoutMs);
  });
}

/** 简易文本 GET（加固：响应体上限 2MB / 非 2xx 直接失败 / 重定向最多 5 跳 + 协议校验）。 */
function getText(url, timeoutMs = 8000, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const options = { headers: { 'User-Agent': 'dsh-supervisor-market' } };
    const req = mod.get(url, options, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        if (redirectsLeft <= 0) return reject(new Error('too many redirects from ' + url));
        // 同 getJson：重定向目标必须校验协议。
        const next = String(res.headers.location);
        if (!/^https?:\/\//i.test(next)) return reject(new Error('重定向到不支持的协议: ' + next.slice(0, 64)));
        return getText(next, timeoutMs, redirectsLeft - 1).then(resolve, reject);
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        return reject(new Error('HTTP ' + res.statusCode + ' from ' + url));
      }
      let b = '';
      let over = false;
      const MAX_BYTES = 2 * 1024 * 1024; // 社区 README 远小于 2MB；防无界缓冲
      res.on('data', (c) => {
        if (over) return;
        b += c;
        if (b.length > MAX_BYTES) { over = true; b = ''; try { req.destroy(); } catch {} reject(new Error('response too large from ' + url)); }
      });
      res.on('end', () => { if (!over) resolve(b); });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.setTimeout(timeoutMs);
  });
}

module.exports = { getJson, getText };
