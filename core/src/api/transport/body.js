'use strict';

// 请求体上限。集中为模块常量，与 platform/ctl/server.js 的同类门限对齐，
// 避免 64KB/1MB 两个数字各自散落在不同实现里。
const DEFAULT_MAX_BYTES = 64 * 1024;

function collectBody(req, res, maxBytes, onDone) {
  const chunks = [];
  let n = 0;
  let over = false;
  req.on('data', (d) => {
    if (over) return;
    chunks.push(d);
    n += d.length;
    if (n > maxBytes) {
      over = true;
      // 413 响应必须真正送达客户端，因此不能在这里 destroy 连接。
      // 实测：res.end() 之后立刻 req.destroy()（无参）会立即拆掉 socket，
      // 已写出的 413 字节来不及 flush，客户端一律收到 ECONNRESET 而非 413
      // （5/5 全部重置）。正确做法是先把剩余 body 丢弃干净，让响应正常收尾，
      // 并显式关闭 keepAlive，避免在超长请求上被复用成一条死连接。
      try {
        if (!res.headersSent) {
          res.setHeader('Connection', 'close');
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'payload too large', limit: maxBytes }));
        }
      } catch {}
    }
  });
  // 请求体流上的错误（客户端中断、截断）必须被观察：此前这里是空处理器，
  // 任何流错误都静默丢弃，表现为请求既不失败也不记日志。
  req.on('error', (e) => {
    if (over) return; // 超限后我们主动收尾，属预期噪声
    try {
      if (!res.headersSent) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'request aborted: ' + ((e && e.message) || e) }));
      } else if (!res.writableEnded) {
        res.end();
      }
    } catch {}
  });
  req.on('end', () => {
    if (over) return;
    const body = Buffer.concat(chunks).toString('utf8');
    try { onDone(body); }
    catch (e) {
      try {
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: (e && e.message) || String(e) }));
        } else if (!res.writableEnded) {
          res.end();
        }
      } catch {}
    }
  });
}

module.exports = { collectBody };
