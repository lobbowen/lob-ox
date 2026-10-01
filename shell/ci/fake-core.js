#!/usr/bin/env node
// 伪内核：CI 启动链与安装冒烟的**被拉起对象**，与真实内核同语义（按实际端口绑定 + 持久化 ports.json + 回 /healthz）；壳的判据链因此与「内核是否真的就绪」解耦。本文件被复制成 <pkg>/bin/dsh-supervisor 使用，两处冒烟共用同一份夹具。
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
