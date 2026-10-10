#!/usr/bin/env node

const http = require('http'), fs = require('fs'), path = require('path');
const dir = path.join(process.env.DSH_SUPERVISOR_HOME, 'supervisor');
let port = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')).apiPort;
const srv = http.createServer((req, res) => {
  if (req.url.startsWith('/healthz')) { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok'); return; }
  res.writeHead(404).end();
});
srv.on('error', (e) => { if (e.code !== 'EADDRINUSE') { console.error(e); process.exit(1); } srv.close(); port += 1; listen(); });
function listen() {
  srv.listen(port, '127.0.0.1', () => {
    fs.writeFileSync(path.join(dir, 'ports.json'), JSON.stringify({ records: [{ role: 'supervisor-api', port }] }));
    console.log('[fake-core] healthz on ' + port);
  });
}
listen();
