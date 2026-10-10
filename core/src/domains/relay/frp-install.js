'use strict';

const zlib = require('node:zlib');

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');
const matrix = require('../../platform/contract/matrix');

const FRP_VERSION = '0.61.1';

const MIRROR_PREFIXES = [
  'https://ghfast.top/',
  'https://gh-proxy.com/',
  '',
];

function frpPlatformTag(platform, arch) {
  return matrix.frpTag(platform, arch);
}

function downloadUrls(asset) {
  const base = 'https://github.com/fatedier/frp/releases/download/v' + FRP_VERSION + '/' + asset;
  return MIRROR_PREFIXES.map((p) => p + base);
}

function download(url, report) {
  return new Promise((resolve, reject) => {
    const get = (u, redirectsLeft) => {
      const mod = u.startsWith('https:') ? https : http;
      const req = mod.get(u, { headers: { 'User-Agent': 'lobox' }, timeout: 60000 }, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirectsLeft > 0) {
          res.resume();
          const next = String(res.headers.location);
          if (!/^https?:\/\//i.test(next)) return reject(new Error('重定向到不支持的协议: ' + next.slice(0, 64)));
          return get(next, redirectsLeft - 1);
        }
        if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
        const total = Number(res.headers['content-length']) || 0;
        const chunks = [];
        let got = 0;
        res.on('data', (c) => { chunks.push(c); got += c.length; if (total && report) report('progress ' + Math.round(got / total * 100) + '%'); });
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      });
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
      req.on('error', reject);
    };
    get(url, 5);
  });
}

async function expectedSha256({ asset, download: dl, report, logger, cache }) {
  const c = cache || {};
  if (c[asset] !== undefined) return c[asset];
  const url = 'https://github.com/fatedier/frp/releases/download/v' + FRP_VERSION + '/frp_' + FRP_VERSION + '_checksums.txt';
  try {
    const buf = await dl(url, () => {});
    const text = String(buf || '');
    const want = new RegExp('^([0-9a-fA-F]{64})\\s+\\*?' + asset.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'm');
    const m = want.exec(text);
    const sum = m ? m[1].toLowerCase() : null;
    c[asset] = sum;
    if (!sum) {
      if (report) report('warn: 官方校验表中未找到 ' + asset + '（安装将被拒绝）');
      if (logger && logger.warn) logger.warn('[frp] 校验表中未找到 ' + asset + ' —— fail-closed：本次安装将被拒绝');
    }
    return sum;
  } catch (e) {
    if (report) report('warn: 取官方校验和失败(' + e.message + ')（安装将被拒绝）');
    if (logger && logger.warn) logger.warn('[frp] 取官方校验和失败：' + e.message + ' —— fail-closed：本次安装将被拒绝，稍后可重试');
    return null;
  }
}

async function extractFrpc(tgzBuf, { destDir, binPath, frpTag }) {
  const tarData = await new Promise((resolve, reject) => {
    zlib.gunzip(tgzBuf, (e, d) => e ? reject(e) : resolve(d));
  });
  let offset = 0;
  while (offset + 512 <= tarData.length) {
    const header = tarData.slice(offset, offset + 512);
    if (header.every((b) => b === 0)) break;
    const name = header.slice(0, 100).toString('utf8').split('\0')[0];
    const sizeStr = header.slice(124, 136).toString('utf8').replace(/[\0 ]/g, '');
    const size = parseInt(sizeStr, 8) || 0;
    const typeFlag = String.fromCharCode(header[156] || 48);
    const dataStart = offset + 512;
    const exe = !!(frpTag && frpTag.exe);
    const wantName = exe ? 'frpc.exe' : 'frpc';
    if ((name.endsWith('/' + wantName) || name === wantName) && (typeFlag === '0' || typeFlag === '\0')) {
      const data = tarData.slice(dataStart, dataStart + size);
      fs.writeFileSync(path.join(destDir, wantName), data);
    }
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  if (!fs.existsSync(binPath)) throw new Error('frpc not found in archive (' + (frpTag ? frpTag.tag : 'unsupported') + ')');
}

async function installFrpc(ctx, onProgress) {
  const report = (msg) => { if (onProgress) try { onProgress(msg); } catch {} };
  fs.mkdirSync(ctx.binDir, { recursive: true });
  if (!ctx.frpTag) {
    const cur = matrix.current();
    if (ctx.events) ctx.events.append('frpc_install_failed', { detail: '当前平台无 frpc 官方产物: ' + cur.platform + '/' + cur.arch });
    return { ok: false, error: '当前平台不支持 FRP（' + cur.platform + '/' + cur.arch + '），仅 linux/darwin/win32 × x64/arm64' };
  }
  const asset = 'frp_' + FRP_VERSION + '_' + ctx.frpTag.tag + '.tar.gz';
  const urls = downloadUrls(asset);
  const expected = await expectedSha256({ asset, download: ctx.download, report, logger: ctx.logger, cache: ctx.sumCache });
  if (!expected) {
    const msg = '无法从官方主机取得 ' + asset + ' 的 sha256，拒绝无完整性校验的安装（fail-closed，可稍后重试）';
    report('failed: ' + msg);
    if (ctx.events) ctx.events.append('frpc_install_failed', { detail: msg });
    return { ok: false, error: msg };
  }
  let lastErr = null;
  for (const url of urls) {
    try {
      report('download: ' + url.slice(0, 60) + '…');
      const tgz = await ctx.download(url, report);
      const got = crypto.createHash('sha256').update(tgz).digest('hex');
      if (got !== expected) {
        throw new Error('SHA256 校验失败（期望 ' + expected.slice(0, 12) + '… 实得 ' + got.slice(0, 12) + '…）——该镜像产物不可信，已拒绝');
      }
      report('SHA256 校验通过');
      report('downloaded ' + Math.round(tgz.length / 1024) + 'KB, extracting…');
      await extractFrpc(tgz, { destDir: ctx.binDir, binPath: ctx.binPath, frpTag: ctx.frpTag });
      fs.chmodSync(ctx.binPath, 0o755);
      report('installed: ' + ctx.binPath);
      if (ctx.events) ctx.events.append('frpc_installed', {});
      return { ok: true, binPath: ctx.binPath };
    } catch (e) {
      lastErr = e;
      report('failed: ' + e.message + ', trying next mirror…');
    }
  }
  if (ctx.events) ctx.events.append('frpc_install_failed', { detail: lastErr ? lastErr.message : '' });
  return { ok: false, error: lastErr ? lastErr.message : 'all mirrors failed' };
}

module.exports = {
  frpPlatformTag,
  downloadUrls,
  download,
  installFrpc,
};
