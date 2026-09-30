'use strict';

// api/transport/body —— 有界 body 读取（传输层原语，与安全模型、域分派无关）。

/** 有界 body 读取：超过 maxBytes（按字节计）时先应答 413 再断开，保证任何输入都有终态应答。
 *  按 Buffer 累积、end 时一次性 utf8 解码——逐块字符串拼接会把跨块多字节字符（CJK/emoji）拆坏。 */
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
      try {
        if (!res.headersSent) {
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'payload too large' }));
        }
      } catch {}
      req.destroy();
    }
  });
  req.on('error', () => {});
  // onDone 在 'end' 事件内同步调用：其异常会逃出请求处理的异常边界、升级为进程级错误，
  // 必须在本层接住并给出终态应答。
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
