'use strict';

const http = require('node:http');

const BOOTSTRAP_TIMEOUT_MS = 3000;
const COOKIE_PREFIX = /^dsh-auth-/;

// 单一实现：把 dsh-auth cookie 从响应里取出来，任何路径都恰好 settle 一次。
// res 流错误必须监听——res 在读完前被对端 RST 时若无 error 监听即成 unhandled 'error'。
function readSetCookie(res, finish) {
  res.on('error', () => finish(null));
  res.resume();
  const raw = res.headers && res.headers['set-cookie'];
  if (!raw || !raw.length) return finish(null);
  // 遍历全部 set-cookie：首个 cookie 可能与 dsh 无关，不能据此判失败。
  for (const line of raw) {
    const pair = String(line).split(';')[0];
    if (pair && COOKIE_PREFIX.test(pair)) return finish(pair);
  }
  return finish(null);
}

function bootstrapDshCookie(targetHost, targetPort, dshToken) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (cookie) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      resolve(cookie);
    };
    // 硬截止：req 的 timeout 只覆盖 socket 空闲，slowloris 式持续滴字节可无限延长。
    const timer = setTimeout(() => {
      try { req.destroy(); } catch {}
      finish(null);
    }, BOOTSTRAP_TIMEOUT_MS);
    if (timer.unref) timer.unref();
    const req = http.get(
      {
        hostname: targetHost,
        port: targetPort,
        path: '/?token=' + encodeURIComponent(dshToken),
        headers: { host: targetHost + ':' + targetPort },
      },
      (res) => readSetCookie(res, finish)
    );
    req.on('error', () => finish(null));
  });
}

module.exports = { bootstrapDshCookie, readSetCookie };
