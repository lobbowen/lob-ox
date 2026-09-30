'use strict';

// 域：原生 DSH（app/native）—— 安装清单读写 + 数据认领（IO：fs，原子写）。

const fs = require('node:fs');
const path = require('node:path');
const { writeAtomic } = require('../../platform/util/fs');
const probe = require('./probe');

/** 读安装清单；不存在/损坏返回 null（唯一读取实现）。 */
function read(host) {
  try { return JSON.parse(fs.readFileSync(host.manifestFile, 'utf8')); } catch { return null; }
}

/** 原子写安装清单（.tmp -> rename），mode 0600；失败不致命（仅告警）。 */
function save(host, m) {
  try {
    fs.mkdirSync(host.stateDir, { recursive: true });
    const f = host.manifestFile;
    fs.mkdirSync(path.dirname(f), { recursive: true });
    writeAtomic(f, JSON.stringify(m, null, 2), { mode: 0o600 });
  } catch (e) { host.logger.warn && host.logger.warn('manifest 保存失败: ' + e.message); }
}

/** 记录安装清单。dataPaths 未显式传则继承既有认领（首装认领不因升级丢失）。
 *  npmRoot 由调用方解析（测试可注入）。 */
function record(host, version, dataPaths, npmRoot) {
  let claim = Array.isArray(dataPaths) ? dataPaths : null;
  if (claim === null) {
    const prev = read(host);
    if (prev && Array.isArray(prev.dataPaths)) claim = prev.dataPaths;
  }
  const bin = probe.binPath(host);
  const pkgDir = npmRoot ? path.join(npmRoot, host.config.packageName || '@deepseek-ai/dsh') : null;
  save(host, {
    installedAt: new Date().toISOString(),
    version,
    binPath: bin || null,
    npmRoot: npmRoot || null,
    packageDir: pkgDir,
    dshHome: host.dshHome,
    dataPaths: claim || [],
  });
}

/** 卸载时可连带删除的数据路径（仅当本 supervisor 是干净 ~/.dsh 的首装者才认领）。
 *  ~/.dsh 已有任一用户数据（sessions/storages/profiles/settings/.credentials）则不认领。 */
function claimDataPaths(host) {
  const paths = [
    path.join(host.dshHome, 'sessions'),
    path.join(host.dshHome, 'storages'),
    path.join(host.dshHome, 'profiles'),
    path.join(host.dshHome, 'settings.yaml'),
    path.join(host.dshHome, '.credentials.yaml'),
    path.join(host.dshHome, '.anonymous-user-id'),
  ];
  for (const p of paths) {
    try { if (fs.existsSync(p)) return []; } catch { return []; }
  }
  return paths;
}

module.exports = { read, save, record, claimDataPaths };
