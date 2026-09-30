#!/usr/bin/env node
// 伪内核：CI 启动链冒烟的**被拉起对象**，与真实内核同语义（按实际端口绑定 + 持久化 ports.json + 回 /healthz）。
// 用途是把「壳的判据链」与「内核是否就绪」解耦：本文件被复制成 <pkg>/bin/dsh-supervisor 使用，
// 由 build job 的 H3 与 install-smoke 的 H10 共用，避免同一夹具两份维护。
const http = require('http'), fs = require('fs'), path = require('path');
const dir = path.join(process.env.DSH_SUPERVISOR_HOME, 'supervisor');
let port = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')).apiPort;
const srv = http.createServer((req, res) => {
  if (req.url.startsWith('/healthz')) { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok'); return; }
  res.writeHead(404).end();
});
// 端口被占则顺延，并把实际端口写进 ports.json —— 壳的 await_ready 每 tick 重读它。
srv.on('error', (e) => { if (e.code !== 'EADDRINUSE') { console.error(e); process.exit(1); } srv.close(); port += 1; listen(); });
function listen() {
  srv.listen(port, '127.0.0.1', () => {
    fs.writeFileSync(path.join(dir, 'ports.json'), JSON.stringify({ records: [{ role: 'supervisor-api', port }] }));
    console.log('[fake-core] healthz on ' + port);
  });
}
listen();
