#!/usr/bin/env node
'use strict';


const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const { PassThrough } = require('node:stream');
const relayProxy = require(path.join(ROOT, 'src', 'domains', 'relay', 'proxy.js'));

const results = [];
const check = (n, c, x) => {
  results.push(!!c);
  console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  <- ' + x : ''));
};

const runUpstream = (headers, chunks, chunkMs) => new Promise((resolve) => {
  const ur = new PassThrough();
  ur.headers = headers || {};
  ur.statusCode = 200;
  const sent = [], warns = [];
  let endAt = 0;
  const res = {
    headers: null,
    writeHead(c, h) { this.code = c; this.headers = h || {}; },
    write(b) { sent.push(Buffer.from(b)); return true; },
    end(b) { if (b != null) sent.push(Buffer.from(b)); endAt = sent.length; finish(); },
    once() {}, on() {},
  };
  const logger = { warn: (m) => warns.push(String(m)) };
  relayProxy.handleUpstream(ur, res, '/index.html', null, logger);
  const finish = () => resolve({ body: Buffer.concat(sent).toString('utf8'), res, warns, endAt });
  (async () => {
    for (const c of chunks) { ur.write(Buffer.from(c)); await new Promise((r) => setTimeout(r, chunkMs || 0)); }
    ur.end();
  })();
});

(async () => {
  {
    const head = '<html><head><title>t</title></head><body>hi</body></html>';
    const r = await runUpstream({ 'content-type': 'text/html' }, [head]);
    const polyfills = (r.body.match(/<script/g) || []).length;
    check('B-a 小文档：polyfill 仍注入（上限改造没把注入改没）且不触发降级告警',
      r.body.includes('</head>') && r.body.indexOf('<script') < r.body.indexOf('</head>') && r.body.endsWith('hi</body></html>')
      && r.warns.length === 0, 'scriptTag=' + polyfills);
  }
  {
    const CAP = relayProxy.HTML_INJECT_MAX_BYTES;
    const marker = 'x'.repeat(1024);
    const big = '<html><head>' + marker.repeat(Math.ceil(CAP / 1024) + 4) + '</head><body>tail</body></html>';
    const r = await runUpstream({ 'content-type': 'text/html' },
      [big.slice(0, 4096), big.slice(4096)], 2);
    check('B-b 超限：按声明长度透传不截断、head 后不再插 script、响应自然结束',
      Buffer.byteLength(r.body) === Buffer.byteLength(big) && r.body.indexOf('<script') < 0
      && r.body.startsWith('<html><head>') && r.body.endsWith('</body></html>'),
      'got=' + Buffer.byteLength(r.body) + ' want=' + Buffer.byteLength(big));
    check('B-b 超限：放弃注入有 warn 留痕（不静默降级）', r.warns.length >= 1, JSON.stringify(r.warns.map((w) => w.slice(0, 60))));
  }
  {
    // 单块即越限且 end 抢先到达：后挂的 pipeWithHold 监听器永不触发 ⇒ 必须自收口。
    const CAP = relayProxy.HTML_INJECT_MAX_BYTES;
    const huge = '<html><head>' + 'y'.repeat(CAP + 10) + '</head><body>z</body></html>';
    const r = await runUpstream({ 'content-type': 'text/html' }, [huge], 0);
    check('B-c 越限单块：res 仍被结束（readableEnded 自收口分支可达）',
      Buffer.byteLength(r.body) === Buffer.byteLength(huge) && r.endAt > 0,
      'got=' + Buffer.byteLength(r.body) + '/' + Buffer.byteLength(huge) + ' endAt=' + r.endAt);
  }
  {
    const CAP = relayProxy.HTML_INJECT_MAX_BYTES;
    const one = 'z'.repeat(1000);
    const doc = '<html><head>' + one.repeat(Math.ceil(CAP / 1000) + 8) + '</head><body>end</body></html>';
    const r = await runUpstream({ 'content-type': 'text/html' },
      [doc.slice(0, 1000), doc.slice(1000, 250000), doc.slice(250000)], 1);
    check('B-d 中途越限：三段字节按序完整（无丢块、无重复头）',
      Buffer.byteLength(r.body) === Buffer.byteLength(doc)
        && r.body.startsWith('<html><head>') && r.body.endsWith('</head><body>end</body></html>')
        && (r.body.match(/<html>/g) || []).length === 1,
      'got=' + Buffer.byteLength(r.body) + '/' + Buffer.byteLength(doc));
  }

  const failed = results.filter((r) => !r);
  console.log('\n结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
