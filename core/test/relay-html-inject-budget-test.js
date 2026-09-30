#!/usr/bin/env node
'use strict';

// ---------------------------------------------------------------------------
// relay HTML 注入的全量缓冲**必须有上限**（超限放弃注入并按流透传，绝不截断）
//
// 缺陷（被测对象：src/domains/relay/proxy.js::handleUpstream）：原实现 `chunks.push(c)`
//   无上限，且 buildForwardHeaders 强制 accept-encoding: identity -> 单个被代理文档按
//   **真实字节无界进内存**（被代理方即可打爆守卫）。上限语义：超限**放弃注入并按流透传**，
//   绝不截断（半份 HTML 会把浏览器打穿），也不静默降级（必须 warn）。
//
// 锁定不变量：B-a 小文档仍注入 polyfill 且无降级告警 · B-b 超限分块：总字节 == 上游总字节、
//   无 script、有 warn、自然结束 · B-c 越限单块（end 抢先）res 仍被结束 · B-d 中途越限 +
//   后续仍有大量块：字节按序完整（无丢块、无重复头）。
// ---------------------------------------------------------------------------

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
  // 第 4 参是 onStatus（传 null）；响应头走 ur.headers（PassThrough 自定义属性）
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
    // 分两块 + 块间延时：越限发生在第二块，其后才是自然 end（贴近真实慢上游）
    const r = await runUpstream({ 'content-type': 'text/html' },
      [big.slice(0, 4096), big.slice(4096)], 2);
    check('B-b 超限：按声明长度透传不截断、head 后不再插 script、响应自然结束',
      Buffer.byteLength(r.body) === Buffer.byteLength(big) && r.body.indexOf('<script') < 0
      && r.body.startsWith('<html><head>') && r.body.endsWith('</body></html>'),
      'got=' + Buffer.byteLength(r.body) + ' want=' + Buffer.byteLength(big));
    check('B-b 超限：放弃注入有 warn 留痕（不静默降级）', r.warns.length >= 1, JSON.stringify(r.warns.map((w) => w.slice(0, 60))));
  }
  {
    // 单块即越限 + end 抢先到达：后挂的 pipeWithHold 监听器永不触发 => 必须自收口
    const CAP = relayProxy.HTML_INJECT_MAX_BYTES;
    const huge = '<html><head>' + 'y'.repeat(CAP + 10) + '</head><body>z</body></html>';
    const r = await runUpstream({ 'content-type': 'text/html' }, [huge], 0);
    check('B-c 越限单块：res 仍被结束（readableEnded 自收口分支可达）',
      Buffer.byteLength(r.body) === Buffer.byteLength(huge) && r.endAt > 0,
      'got=' + Buffer.byteLength(r.body) + '/' + Buffer.byteLength(huge) + ' endAt=' + r.endAt);
  }
  {
    // 多块 + 中途越限 + 后续仍有大量块：三段字节都要按序到达（当前块自转写 + 余下由 pipeWithHold 接管）
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
  // 反向对照（阈值必须有限）= B-b/B-c/B-d 的字节相等判据已行为级覆盖；
  //   原对 HTML_INJECT_MAX_BYTES 的 [1MB,16MB] 区间常量断言已按减重裁定删除（常量自证）。

  const failed = results.filter((r) => !r);
  console.log('\n结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
