'use strict';

// 安装标识（RELEASE-CHANNEL-CONTRACT）：自行生成 UUID 并持久化，不用 IP/主机名/MAC（会变、共享、可伪造）。
// 首次生成此后只读：UUID 漂移会让已入灰度名单的机器突然失配；读/写失败一律返回 null 并记录原因，绝不静默新建或覆盖。
// 落盘 0600（标识即身份）；DSH_CANARY_ID 可显式覆盖。

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { writeAtomic } = require('../util/fs');
const { supervisorDir } = require('./state-root');

/** 标识文件名（位于内核状态根下；壳读同一文件，见契约跨仓一致性）。 */
const FILE_NAME = 'install-id';

/** 环境变量覆盖（显式声明本机身份；测试/特殊部署用）。 */
const ENV_OVERRIDE = 'DSH_CANARY_ID';

/** UUID v4 字面量（用于校验文件内容没被写坏）。 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** 进程内缓存：同一进程内 UUID 恒定，避免每次都读盘。 */
let _cached = null;

/** 标识文件路径（导出以便测试与壳侧对齐口径）。 */
function installIdPath() {
  return path.join(supervisorDir(), FILE_NAME);
}

/** 读取本机安装标识；source 为 'env'/'file'/'created'（诊断用）。
 *  null 表示无法确定：调用方必须按无标识处理并如实告知，绝不随便造一个。 */
function readInstallId() {
  if (_cached) return _cached;

  const env = process.env[ENV_OVERRIDE];
  if (typeof env === 'string' && env.trim()) {
    _cached = { id: env.trim(), source: 'env' };
    return _cached;
  }

  const fp = installIdPath();

  try {
    const raw = fs.readFileSync(fp, 'utf8');
    const id = String(raw).split(/\r?\n/)[0].trim();
    if (UUID_RE.test(id)) {
      _cached = { id: id.toLowerCase(), source: 'file' };
      return _cached;
    }
    // 内容非法（被改坏/写了一半）时不覆盖：覆盖即改变身份，保持原样让运维可见并人工处置才是安全方向。
    console.warn('[install-id] ' + fp + ' 内容不是合法 UUID，拒绝覆盖（请人工处置）：' + JSON.stringify(id.slice(0, 40)));
    return null;
  } catch (e) {
    if (e && e.code !== 'ENOENT') {
      // 存在但读不了（权限等）同样属于「无法确定」，不新建。
      console.warn('[install-id] 读取失败（不新建，避免标识漂移）：' + e.message);
      return null;
    }
  }

  // 确实不存在（ENOENT）才首次生成并落盘。
  try {
    const dir = path.dirname(fp);
    fs.mkdirSync(dir, { recursive: true });
    const id = crypto.randomUUID();
    writeAtomic(fp, id + '\n', { mode: 0o600 });
    _cached = { id: id.toLowerCase(), source: 'created' };
    return _cached;
  } catch (e) {
    // 写失败不返回内存临时 UUID：本次运行会自认为在名单内、重启后又变，行为不可复现。
    console.warn('[install-id] 生成/落盘失败（本次无标识）：' + e.message);
    return null;
  }
}

/** 便捷读取：只要标识值（无标识时 null）。 */
function installId() {
  const r = readInstallId();
  return r ? r.id : null;
}

/** 测试用：清空进程内缓存（生产代码不应调用）。 */
function _resetCache() { _cached = null; }

module.exports = { installId, readInstallId, installIdPath, FILE_NAME, ENV_OVERRIDE, UUID_RE, _resetCache };
