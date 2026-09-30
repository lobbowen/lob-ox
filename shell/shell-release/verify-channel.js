#!/usr/bin/env node
'use strict';

// 发布通道冒烟 H11：从**用户实际会读到的端点**取清单，验签名与字节。
// 判的是「发布出去的东西可不可用」，不是「本仓代码对不对」（H2/H7 判后者）。
// 端点与公钥都从 tauri.conf.json 读：这里再写一遍就会与真客户端漂移。

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const EXPECT_PLATFORMS = ['linux-x86_64', 'windows-x86_64', 'darwin-aarch64', 'darwin-x86_64'];

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

// minisign 公钥 = base64( "untrusted comment: ... key: <ID>\n" + base64( alg(2) keyId(8) key(32) ) )
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

// 清单里的 signature 是双层 base64：外层解出 4 行 minisign 文本，第二行再解出 alg(2)+keyId(8)+ed25519(64)=74 字节。
// 这里只判「钥匙是不是配置里那把」「字节是不是本次构建那份」；签名有效性归 updater_artifacts V2/V3/V4
// （与用户端同一个 minisign-verify crate）。在 node 里重实现验签只有两种结局：口径不对年年假红，
// 口径错了还判绿 —— minisign 的 "ED" 是 prehash 变体，Node stdlib 的纯 Ed25519 对已知正确三元组也验不过。
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

// 清单键 -> 本次构建产物目录名（与 make-manifest.js 的 platToPkg 同一映射，产物按它分目录）。
// 必须按键选目录：两个 mac 平台都把更新产物叫 dsh-supervisor.app.tar.gz，只按文件名比对会串台。
const ARTIFACT_DIR = {
  'linux-x86_64': 'linux-x64', 'linux-aarch64': 'linux-arm64',
  'darwin-x86_64': 'darwin-x64', 'darwin-aarch64': 'darwin-arm64',
  'windows-x86_64': 'win-x64', 'windows-aarch64': 'win-arm64',
};

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
  const sub = path.join(root, ARTIFACT_DIR[key] || '');
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

  // 端点按顺序就是客户端的尝试顺序：主端点取不到 = 用户取不到，判失败；
  // 备用端点只在它也返回清单时要求内容一致（CDN 同步延迟不该让发布判定变红，但要留痕）。
  let manifest = null;
  let primaryErr = '';
  for (let i = 0; i < tries; i += 1) {
    try {
      const buf = await fetchBuf(endpoints[0], 1);
      const m = JSON.parse(buf.toString('utf8'));
      const missing = wantPlatforms.filter((k) => !m.platforms || !m.platforms[k]);
      if (m.version === ver && !missing.length) { manifest = m; break; }
      primaryErr = '版本 ' + m.version + '（期望 ' + ver + '）缺平台 ' + (missing.join(',') || '无');
    } catch (e) { primaryErr = String(e.message || e); }
    console.log('第 ' + (i + 1) + '/' + tries + ' 次主端点未就绪: ' + primaryErr);
    await sleep(Number(a.settle || 60000));
  }
  if (!manifest) fail('主端点 ' + endpoints[0] + ' 在预算内没取到 ' + ver + ' 的完整清单: ' + primaryErr);
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
        fail(key + ' 的产物 ' + name + ' 在本次构建产物里找不到（' + artDir + '/' + (ARTIFACT_DIR[key] || '?') + '）');
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
