'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { writeDurable } = require('../../platform/util/fs');
const probe = require('./probe');

function read(host) {
  try { return JSON.parse(fs.readFileSync(host.manifestFile, 'utf8')); } catch { return null; }
}

function save(host, m) {
  try {
    fs.mkdirSync(host.stateDir, { recursive: true });
    const f = host.manifestFile;
    fs.mkdirSync(path.dirname(f), { recursive: true });
    writeDurable(f, JSON.stringify(m, null, 2), { mode: 0o600 });
  } catch (e) { host.logger.warn && host.logger.warn('manifest 保存失败: ' + e.message); }
}

function record(host, version, dataPaths, npmRoot) {
  let claim = Array.isArray(dataPaths) ? dataPaths : null;
  if (claim === null) {
    const prev = read(host);
    if (prev && Array.isArray(prev.dataPaths)) claim = prev.dataPaths;
  }
  const bin = probe.binPath(host);
  // R7-架构：包名缺省时不再假定旧产品名 @deepseek-ai/dsh。
  // 原硬编码让 manifest 的 packageDir 指向一个本产品从不安装的包，
  // uninstall 的 safeAncestors 也会把那个目录算进「产品数据根」，
  // 于是清理清单里出现 DSH 的路径（被越界检查拦下，但本就该在源头就不产生）。
  const pkgName = host.config.packageName;
  const pkgDir = (npmRoot && pkgName) ? path.join(npmRoot, pkgName) : null;
  save(host, {
    installedAt: new Date().toISOString(),
    version,
    binPath: bin || null,
    npmRoot: npmRoot || null,
    packageDir: pkgDir,
    dataPaths: claim || [],
  });
}

// R7-架构：内核（服务层）不再 claim DSH 的数据目录。
// 原实现返回 dshHome 下的 sessions/storages/profiles/settings.yaml/.credentials.yaml/
// .anonymous-user-id，写进 manifest.dataPaths 后 uninstall 按清单删除——
// 那是另一个产品（DeepSeek Harness）的用户数据，本产品无权清。
// 现状：返回空数组（不 claim 任何外部数据路径），dataPaths 只由调用方显式传入。
function claimDataPaths(host) {
  return [];
}

module.exports = { read, save, record, claimDataPaths };
