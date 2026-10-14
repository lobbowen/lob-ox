'use strict';

const http = require('node:http');

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
