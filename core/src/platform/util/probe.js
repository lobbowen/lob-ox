'use strict';

const net = require('node:net');
const http = require('node:http');
const https = require('node:https');

function portListening(host, port, timeoutMs = 1000) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    let done = false;
    const finish = (ok) => {
      if (!done) {
        done = true;
        socket.destroy();
        resolve(ok);
      }
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

function httpProbe(url, timeoutMs = 3000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok, status) => {
      if (done) return;
      done = true;
      resolve({ ok: !!ok, status });
    };
    let u;
    try {
      u = new URL(url);
    } catch {
      return finish(false, null);
    }
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.get(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        timeout: timeoutMs,
        headers: { 'User-Agent': 'dsh-supervisor-probe' },
      },
      (res) => {
        res.resume();
        const sc = res.statusCode;
        finish((sc >= 200 && sc < 300) || sc === 401 || sc === 403, sc);
      }
    );
    req.on('timeout', () => {
      req.destroy();
      finish(false, null);
    });
    req.on('error', () => finish(false, null));
  });
}

module.exports = { portListening, httpProbe };
