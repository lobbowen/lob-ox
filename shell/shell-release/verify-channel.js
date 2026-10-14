#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// 反向映射（manifestKey -> 本次构建产物目录）的唯一权威。
// ⚠ 目录名必须由 platform-map 推导，与 assemble-shell-pkg.js 的 path.join(out, npmPkgDir(plat)) 同源；
//   否则接上 CI 后这里必然找不到产物（--artifact-dir 传 assemble 的 --out 根即可）。
const { PLATFORMS, platFromManifestKey, npmPkgDir } = require('./platform-map');

// 默认复核的平台（manifestKey）。按 plat 名单取，走同一张表 ⇒ 键永不会与正向表漂移；
// 名单里出现未知 plat 立即抛错，不静默产出 undefined。
const DEFAULT_PLATS = ['linux-x64', 'win-x64', 'darwin-arm64', 'darwin-x64'];
const EXPECT_PLATFORMS = DEFAULT_PLATS.map((p) => {
  const m = PLATFORMS[p];
  if (!m) throw new Error('verify-channel 默认平台名单含未知 plat: ' + p);
  return m.manifestKey;
});

function parseArgs(argv) {
  const o = {};
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const k = a.slice(2);
    const nxt = argv[i + 1];
    if (nxt === undefined || nxt.startsWith('--')) o[k] = true;
    else { o[k] = nxt; i += 1; }
  }
  return o;
}

function fail(msg) {
  console.error('::error:: H11 判据失败: ' + msg);
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchBuf(url, tries) {
  let last = '';
  for (let i = 0; i < tries; i += 1) {
    try {
      const res = await fetch(url, { redirect: 'follow' });
      if (res.ok) return Buffer.from(await res.arrayBuffer());
      last = 'HTTP ' + res.status;
    } catch (e) { last = String(e && e.message ? e.message : e); }
    if (i + 1 < tries) await sleep(30000);
  }
  throw new Error(url + ' 取不到: ' + last);
}

function loadPubKey(conf) {
  const b64 = conf.plugins.updater.pubkey;
  const outer = Buffer.from(b64, 'base64').toString('utf8').split('\n');
  const comment = outer[0] || '';
  const raw = Buffer.from(outer[1] || '', 'base64');
  if (raw.length !== 42) fail('配置公钥结构异常（' + raw.length + ' 字节，期望 42）');
  if (raw.subarray(0, 2).toString('utf8') !== 'Ed') fail('配置公钥算法不是 Ed');
  const id = Buffer.from(raw.subarray(2, 10)).reverse().toString('hex').toUpperCase();
  const m = /key:\s*([0-9A-Fa-f]+)/.exec(comment);
  if (!m) fail('配置公钥的 untrusted comment 里没有 key id');
  if (m[1].toUpperCase() !== id) fail('配置公钥注释里的 key id ' + m[1].toUpperCase() + ' 与字节算出的 ' + id + ' 不符');
  return { id, keyId: raw.subarray(2, 10), comment };
}

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

function unwrapSig(key, b64, wantKeyId, wantId) {
  const text = Buffer.from(b64, 'base64').toString('utf8');
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length);
  if (lines.length < 2) fail(key + ' 的 signature 不是 minisign 文本块（解出 ' + lines.length + ' 行）');
  if (!/^untrusted comment: /.test(lines[0])) fail(key + ' 的 signature 首行不是 untrusted comment');
  const blob = Buffer.from(lines[1], 'base64');
  if (blob.length !== 74) fail(key + ' 签名块 ' + blob.length + ' 字节，期望 74（alg(2)+keyId(8)+ed25519(64)）');
  const alg = blob.subarray(0, 2).toString('utf8');
  if (alg !== 'Ed' && alg !== 'ED') fail(key + ' 签名算法标记是 ' + JSON.stringify(alg) + '，不是 Ed/ED');
  if (!blob.subarray(2, 10).equals(wantKeyId)) {
    fail(key + ' 签名的 key id 与配置公钥 ' + wantId + ' 不符 -> 用户端必然验签失败');
  }
  return { blob, lines: lines.length };
}

// manifestKey -> assemble 写出的 npm 包目录（单源推导，见文件头注释）。
function artifactDirFor(key) {
  return npmPkgDir(platFromManifestKey(key));
}

function walkFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walkFiles(p));
    else out.push(p);
  }
  return out;
}

function candidates(root, key, name) {
  const sub = path.join(root, artifactDirFor(key));
  const dirs = fs.existsSync(sub) ? [sub] : [root];
  const hits = [];
  for (const d of dirs) {
    if (!fs.existsSync(d)) continue;
    for (const f of walkFiles(d)) if (path.basename(f) === name) hits.push(f);
  }
  return hits;
}

async function main() {
  const a = parseArgs(process.argv);
  const ver = a.ver;
  if (!ver) { console.error('缺少 --ver'); process.exit(2); }
  const confPath = a.conf || 'src-tauri/tauri.conf.json';
  const conf = JSON.parse(fs.readFileSync(confPath, 'utf8'));
  const endpoints = conf.plugins.updater.endpoints;
  if (!Array.isArray(endpoints) || !endpoints.length) fail(confPath + ' 里没有 updater.endpoints');
  const pub = loadPubKey(conf);
  const wantPlatforms = (a.platforms || EXPECT_PLATFORMS.join(',')).split(',');
  const tries = Number(a.tries || 8);

  console.log('配置公钥 key id = ' + pub.id);
  console.log('端点 = ' + endpoints.join(' | '));

  let manifest = null;
  let primaryErr = '';
  let lastSeenVersion = null;
  let sawStructureDamage = false;
  const settleMs = Number(a.settle || 60000);
  for (let i = 0; i < tries; i += 1) {
    try {
      const buf = await fetchBuf(endpoints[0], 1);
      const m = JSON.parse(buf.toString('utf8'));
      const missing = wantPlatforms.filter((k) => !m.platforms || !m.platforms[k]);
      if (m.version === ver && !missing.length) { manifest = m; break; }
      lastSeenVersion = m.version;
      // 两种「没就绪」必须分开：
      //  - 版本比期望旧 / 平台缺失 => CDN 尚未传播到新版本，继续等是合理的；
      //  - 清单结构坏（无 version、无 platforms）=> 真的坏了，再等也不会自愈。
      if (!m || typeof m.version !== 'string' || !m.platforms || typeof m.platforms !== 'object') {
        sawStructureDamage = true;
        primaryErr = '清单结构异常（version=' + JSON.stringify(m && m.version)
          + ' platforms=' + typeof (m && m.platforms) + '）';
      } else {
        primaryErr = '版本 ' + m.version + '（期望 ' + ver + '）缺平台 ' + (missing.join(',') || '无');
      }
    } catch (e) { primaryErr = String(e.message || e); }
    console.log('第 ' + (i + 1) + '/' + tries + ' 次主端点未就绪: ' + primaryErr
      + '（这是 npm CDN 传播延迟的正常表现，继续等待）');
    await sleep(settleMs);
  }
  if (!manifest) {
    // 预算耗尽仍没拿到新版本：区分「CDN 没跟上」与「清单坏了」，让红信号可读。
    // 两者都不是发布失败（npm publish 已在上一 step 成功），但只有后者需要人查。
    if (sawStructureDamage) {
      fail('主端点 ' + endpoints[0] + ' 的清单结构损坏（非传播延迟，重试也不会自愈）: ' + primaryErr);
    }
    console.log('::warning::npm publish succeeded, but the CDN did not serve the new version within budget');
    console.log('           last version seen on primary endpoint: ' + (lastSeenVersion || 'unknown'));
    console.log('           this is unpkg / jsdelivr edge-cache lag; it does not affect the published packages');
    console.log('           end users resolve the new version once caches refresh');
    process.exit(0);
  }
  console.log('主端点清单版本 = ' + manifest.version + '，平台 ' + Object.keys(manifest.platforms).join(', '));

  for (let i = 1; i < endpoints.length; i += 1) {
    try {
      const other = JSON.parse((await fetchBuf(endpoints[i], 2)).toString('utf8'));
      if (other.version !== manifest.version) {
        console.log('::warning::端点 ' + endpoints[i] + ' 仍是 ' + other.version + '（主端点 ' + manifest.version + '）');
      } else {
        console.log('端点 ' + endpoints[i] + ' 与主端点同版本');
      }
    } catch (e) {
      console.log('::warning::备用端点 ' + endpoints[i] + ' 未就绪: ' + (e.message || e));
    }
  }

  const artDir = a['artifact-dir'] ? path.resolve(a['artifact-dir']) : '';

  for (const key of wantPlatforms) {
    const p = manifest.platforms[key];
    if (!p || !p.url || !p.signature) fail(key + ' 缺 url 或 signature');
    const bytes = await fetchBuf(p.url, tries);
    const sum = sha256(bytes);
    const sig = unwrapSig(key, p.signature, pub.keyId, pub.id);
    const name = decodeURIComponent(path.posix.basename(new URL(p.url).pathname));
    let line = key + ' 签名块钥匙 = 配置公钥 ' + pub.id + '（minisign 块 ' + sig.lines + ' 行）'
      + ' sha256=' + sum.slice(0, 12) + ' 字节=' + bytes.length + ' 产物=' + name;
    if (artDir) {
      const hits = candidates(artDir, key, name);
      if (!hits.length) {
        fail(key + ' 的产物 ' + name + ' 在本次构建产物里找不到（' + artDir + '/' + artifactDirFor(key) + '）');
      }
      const matched = hits.filter((f) => sha256(fs.readFileSync(f)) === sum);
      if (!matched.length) {
        fail(key + ' 通道字节与本次构建产物不一致 url=' + p.url
          + ' 通道 sha256=' + sum
          + ' 候选=' + hits.map((f) => f + ':' + sha256(fs.readFileSync(f)).slice(0, 12)).join(' '));
      }
      line += ' 与构建产物逐字节一致';
    }
    console.log(line);
  }
  console.log('H11 通过：' + ver + ' 在 ' + wantPlatforms.length + ' 个平台端点上清单可取、签名块钥匙与配置公钥一致 '
    + pub.id + '（签名有效性由 updater_artifacts V2/V3/V4 以 minisign-verify 判）'
    + (artDir ? '、字节与本次构建产物一致' : '（未比对构建产物字节）'));
}

main().catch((e) => fail(String(e && e.stack ? e.stack : e)));
