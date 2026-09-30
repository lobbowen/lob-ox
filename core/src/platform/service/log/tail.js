'use strict';

// ctl 拉取与运行日志尾读（纯 IO）。

const fs = require('node:fs');
const http = require('node:http');

// 调目标的 ctl 通道（POST /ctl {method,args}），返回 value；失败抛错。唯一实现，勿重复实现。
function ctlCall(port, method, args, timeoutMs, opts) {
  const o = opts || {};
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ method, args: Array.isArray(args) ? args : [] });
    const req = http.request({
      host: '127.0.0.1', port, path: '/ctl', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: timeoutMs || 3000,
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        try {
          const j = JSON.parse(buf || '{}');
          if (j && j.ok) return resolve(j.value);
          const err = new Error((j && j.error) || ('ctl:' + port + ' ' + method + ' failed'));
          if (o.withErrorFields) { err.ok = false; err.error = (j && j.error) || null; }
          return reject(err);
        } catch { reject(new Error('ctl:' + port + ' 响应解析失败')); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('ctl:' + port + ' 超时')));
    req.on('error', reject);
    req.end(body);
  });
}

// 读运行日志文件尾部（排障用 /logs/tail）。
function tailFile(file, n) {
  if (!file) return [];
  try {
    const all = fs.readFileSync(file, 'utf8');
    const lines = all.split('\n').filter(Boolean);
    return lines.slice(-Math.max(1, Number(n) || 100));
  } catch { return []; }
}

module.exports = { ctlCall, tailFile };
