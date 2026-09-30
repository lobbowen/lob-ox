'use strict';

// dsh-auth 派生令牌的换取（DshTokenService 契约1 的 exchange 策略）。
// 协议：GET /?token=<launchToken> 返回 303 与 Set-Cookie: dsh-auth-<hash>=<v1 前缀值>；生成侧是 DSH 进程，我方负责换取。
// 本模块不缓存任何结果：dshCookie 缓存由调用方 relay 掌握，令牌值始终由令牌池按需提供。

const http = require('node:http');

/** 用 DSH 启动令牌向回环 DSH 换取浏览器会话 cookie（dsh-auth-*）。
 *  协议：GET /?token=<launchToken> 返回 303 与 Set-Cookie。失败或非 dsh-auth 返回 null。 */
function bootstrapDshCookie(targetHost, targetPort, dshToken) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (cookie) => {
      if (done) return;
      done = true;
      resolve(cookie);
    };
    const req = http.get(
      {
        hostname: targetHost,
        port: targetPort,
        path: '/?token=' + encodeURIComponent(dshToken),
        headers: { host: targetHost + ':' + targetPort },
        timeout: 3000,
      },
      (res) => {
        res.resume();
        const raw = res.headers['set-cookie'];
        if (raw && raw.length) {
          const pair = String(raw[0]).split(';')[0];
          // 只接受 dsh-auth-*：否则会把任意 Set-Cookie（反代或中间件 cookie）当成会话 cookie，
          // 形成 state.cookieReady=true 的假就绪，实际 DSH 仍 401。
          if (pair && /^dsh-auth-/.test(pair)) finish(pair);
          else finish(null);
        } else {
          finish(null);
        }
      }
    );
    req.on('timeout', () => { try { req.destroy(); } catch {} finish(null); });
    req.on('error', () => finish(null));
  });
}

module.exports = { bootstrapDshCookie };
