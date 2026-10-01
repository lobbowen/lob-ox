#!/usr/bin/env node
'use strict';

// frpc 下载必须校验完整性：它经两个第三方代理前缀 + 最多 5 跳重定向下载，却只校验 HTTP 200 与 gzip/tar 可解析，
//   随即 chmod 0755 落盘并 detached 执行（镜像或链路被投毒即在用户机上写盘执行任意二进制）。
//   信任根：校验和从**官方 GitHub 主机直连**取得（frp_<ver>_checksums.txt），不经镜像前缀；A 不匹配 -> 失败且不落盘 · B 匹配 -> 成功 · C 取不到 -> 拒绝且不落盘。

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const ROOT = path.join(__dirname, '..');

const results = [];
const check = (n, c, x) => {
  results.push(!!c);
  console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  <- ' + x : ''));
};

/** 造一个合法的 tar.gz（内含 <tag>/frpc），用于桩 _download。 */
function makeTarGz(frpcBody) {
  const tag = 'frp_0.61.1_linux_amd64';
  const file = 'frpc';
  const data = Buffer.from(frpcBody, 'utf8');
  const header = Buffer.alloc(512);
  header.write(tag + '/' + file, 0, 100, 'utf8');
  header.write('0000644\0', 100, 8, 'ascii');
  header.write('0000000\0', 108, 8, 'ascii');
  header.write('0000000\0', 116, 8, 'ascii');
  header.write(data.length.toString(8).padStart(11, '0') + '\0', 124, 12, 'ascii');
  header.write('00000000000\0', 136, 12, 'ascii');
  header.write('0'.repeat(7) + '\0', 148, 8, 'ascii'); // 类型 0 = 普通文件
  let sum = 0;
  for (const b of header) sum += b;
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  const pad = Buffer.alloc((512 - (data.length % 512)) % 512);
  const end = Buffer.alloc(1024);
  return zlib.gzipSync(Buffer.concat([header, data, pad, end]));
}

(async () => {
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'r13frp-'));
  //  结构改造：FrpManager 在 frp.js；下载/校验在 frp-install.js。
  const { FrpManager } = require(path.join(ROOT, 'src', 'domains', 'relay', 'frp.js'));

  const goodTgz = makeTarGz('#!/bin/sh\necho frpc\n');
  const goodSum = crypto.createHash('sha256').update(goodTgz).digest('hex');
  const asset = 'frp_0.61.1_linux_amd64.tar.gz';

  const mk = (sumText, tgz) => {
    const mgr = new FrpManager({
      dir: path.join(TMP, 's-' + Math.random().toString(36).slice(2)),
      logger: { warn() {}, info() {}, error() {} },
    });
    // 覆盖 frpTag 后**必须同步重算 binPath**（构造函数按真实平台算，Windows 上是 frpc.exe），
    //   否则夹具会在 Windows 上出现「解包写 bin/frpc、断言看 bin/frpc.exe」的自身缺陷。
    mgr.frpTag = { os: 'linux', arch: 'amd64', tag: 'linux_amd64', exe: false };
    mgr.binPath = path.join(mgr.binDir, mgr.frpTag.exe ? 'frpc.exe' : 'frpc');
    mgr._sumCache = {};
    // 桩网络层：官方校验表 + 归档下载
    mgr._download = async (url) => {
      if (url.indexOf('_checksums.txt') >= 0) {
        if (sumText === null) throw new Error('official unreachable');
        return Buffer.from(sumText, 'utf8');
      }
      return tgz;
    };
    return { mgr };
  };

  console.log('== A 校验和不匹配必须拒绝 ==');
  {
    const wrong = 'f'.repeat(64);
    const { mgr } = mk(wrong + '  ' + asset + '\n', goodTgz);
    const r = await mgr.install(() => {});
    check('A install 失败（拒绝不可信产物）', r.ok === false, JSON.stringify(r).slice(0, 120));
    check('A **未落盘** frpc（不执行不可信二进制）', !fs.existsSync(mgr.binPath), String(fs.existsSync(mgr.binPath)));
  }

  console.log('== B 校验和匹配必须放行 ==');
  {
    const { mgr } = mk(goodSum + '  ' + asset + '\n', goodTgz);
    const r = await mgr.install(() => {});
    check('B install 成功', r.ok === true, JSON.stringify(r).slice(0, 120));
    check('B frpc 已落盘', fs.existsSync(mgr.binPath), '存在');
  }

  console.log('== C 取不到校验和 → 拒绝安装（A2 fail-closed）==');
  {
    // C1 官方主机不可达（_download 抛错）；C2 校验表可达但缺该 asset 行 -> expectedSha256 返回 null
    const { mgr } = mk(null, goodTgz);
    const r = await mgr.install(() => {});
    const other = 'a'.repeat(64) + '  frp_0.61.1_windows_arm64.tar.gz\n';
    const { mgr: mgr2 } = mk(other, goodTgz);
    const r2 = await mgr2.install(() => {});
    check('C1/C2 官方不可达 / 校验表缺项：拒绝安装（不再降级放行）且**未落盘**',
      r.ok === false && !fs.existsSync(mgr.binPath) && r2.ok === false && !fs.existsSync(mgr2.binPath),
      JSON.stringify(r).slice(0, 80) + ' exists=' + fs.existsSync(mgr.binPath) + ' | ' + JSON.stringify(r2).slice(0, 80));
  }
  {
    // C3 离线一次不得永久化：先失败（不可达），再恢复可得校验和 -> 必须能装成功
    const { mgr } = mk(null, goodTgz);
    const r1 = await mgr.install(() => {});
    check('C3 首次（不可达）失败', r1.ok === false, JSON.stringify(r1).slice(0, 80));
    mgr._download = async (url) => {
      if (url.indexOf('_checksums.txt') >= 0) return Buffer.from(goodSum + '  ' + asset + '\n', 'utf8');
      return goodTgz;
    };
    const r2 = await mgr.install(() => {});
    check('C3 恢复后重试成功（失败未污染缓存）', r2.ok === true, JSON.stringify(r2).slice(0, 120));
  }

  fs.rmSync(TMP, { recursive: true, force: true });
  const failed = results.filter((r) => !r);
  console.log('\n结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
