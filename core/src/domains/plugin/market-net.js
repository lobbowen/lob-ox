'use strict';

const http = require('node:http');
const https = require('node:https');

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

function getText(url, timeoutMs = 8000, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const options = { headers: { 'User-Agent': 'dsh-supervisor-market' } };
    const req = mod.get(url, options, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        if (redirectsLeft <= 0) return reject(new Error('too many redirects from ' + url));
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
      const MAX_BYTES = 2 * 1024 * 1024;
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
