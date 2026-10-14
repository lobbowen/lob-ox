'use strict';

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
