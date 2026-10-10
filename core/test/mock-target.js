#!/usr/bin/env node
'use strict';


const http = require('node:http');

const port = Number(process.argv[2] || 3901);

if (process.env.MOCK_EXIT_ON_START === '1') {
  process.exit(1);
}

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('ok');
});

server.on('error', (err) => {
  console.error('mock listen error:', err.message);
  process.exit(1);
});

server.listen(port, '127.0.0.1', () => {
  console.log(`mock listening on ${port} pid=${process.pid}`);
});

process.on('SIGTERM', () => process.exit(0));
