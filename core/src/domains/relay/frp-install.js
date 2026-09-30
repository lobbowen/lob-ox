'use strict';

const zlib = require('node:zlib');

// frp 安装：平台标签 / 镜像 URL / 下载 / sha256 完整性校验 / 纯 JS 解压（进程托管在 frp.js）。
// 信任根：校验和直连官方 GitHub 取（frp_<ver>_checksums.txt），不经镜像前缀——只控制镜像的攻击者
// 无法同时伪造校验和。取不到或不匹配期望校验和即拒绝安装（A2 fail-closed）：
// frpc 是被本守卫长期托管执行的第三方二进制，宁失败也不装入未校验产物。

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');
// os/arch 到标签的映射只在 src/platform/contract/matrix.js（平台知识唯一事实源）。
const matrix = require('../../platform/contract/matrix');

const FRP_VERSION = '0.61.1';

// 下载镜像前缀（国内镜像优先，GitHub 官方兜底）；URL 主体按平台动态生成。
const MIRROR_PREFIXES = [
  'https://ghfast.top/',
  'https://gh-proxy.com/',
  '', // GitHub 官方直连
];

/** FRP 官方发布平台标签：委托 matrix；当前平台无官方产物时返回 null（调用方据此拒绝安装）。 */
function frpPlatformTag(platform, arch) {
  return matrix.frpTag(platform, arch);
}

function downloadUrls(asset) {
  const base = 'https://github.com/fatedier/frp/releases/download/v' + FRP_VERSION + '/' + asset;
  return MIRROR_PREFIXES.map((p) => p + base);
}

/** HTTP(S) 下载（最多 5 跳重定向），返回完整 Buffer。 */
function download(url, report) {
  return new Promise((resolve, reject) => {
    const get = (u, redirectsLeft) => {
      const mod = u.startsWith('https:') ? https : http;
      const req = mod.get(u, { headers: { 'User-Agent': 'dsh-supervisor' }, timeout: 60000 }, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirectsLeft > 0) {
          res.resume();
          // 重定向目标必须校验协议：file:// 会让 http.get 同步抛（响应回调内逃逸为 uncaughtException）。
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

/** 取官方校验表里的期望 sha256：直连官方主机，不经镜像（信任根见文件头）。
 *  返回 null = 取不到（离线/官方不可达/表内缺项），调用方按 A2 fail-closed 拒绝安装并记 warn。
 *  结果按 asset 缓存在调用方传入的 cache（一次安装只需取一次）。 */
async function expectedSha256({ asset, download: dl, report, logger, cache }) {
  const c = cache || {};
  if (c[asset] !== undefined) return c[asset];
  const url = 'https://github.com/fatedier/frp/releases/download/v' + FRP_VERSION + '/frp_' + FRP_VERSION + '_checksums.txt';
  try {
    const buf = await dl(url, () => {});
    const text = String(buf || '');
    // 官方表格式：每行 "<64hex>  <filename>"
    const want = new RegExp('^([0-9a-fA-F]{64})\\s+\\*?' + asset.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'm');
    const m = want.exec(text);
    const sum = m ? m[1].toLowerCase() : null;
    c[asset] = sum;
    if (!sum) {
      if (report) report('warn: 官方校验表中未找到 ' + asset + '（安装将被拒绝）');
      if (logger && logger.warn) logger.warn('[frp] 校验表中未找到 ' + asset + ' —— fail-closed：本次安装将被拒绝（A2）');
    }
    return sum;
  } catch (e) {
    // 失败不写 cache：离线一次不得让本进程后续永久拒绝安装。
    if (report) report('warn: 取官方校验和失败(' + e.message + ')（安装将被拒绝）');
    if (logger && logger.warn) logger.warn('[frp] 取官方校验和失败：' + e.message + ' —— fail-closed：本次安装将被拒绝，稍后可重试（A2）');
    return null;
  }
}

/** 从 tar.gz 提取 frpc 二进制（纯 Node 实现 gzip+tar 解析）。 */
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
    // 平台化：Windows 官方产物内二进制为 frpc.exe；其余平台 frpc。
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

/** 安装 frpc：镜像回退下载，完整性校验，解压，chmod。 */
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
  // A2 fail-closed：取不到期望校验和（GitHub 直连不可达/校验表缺项）即拒绝安装，
  //   绝不装入未校验二进制 —— 安装失败可重试，被投毒的 frpc 会长期驻留。
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
