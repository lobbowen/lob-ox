'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { writeAtomic } = require('../util/fs');
const { supervisorDir } = require('./state-root');

const FILE_NAME = 'install-id';

const ENV_OVERRIDE = 'DSH_CANARY_ID';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

let _cached = null;

function installIdPath() {
  return path.join(supervisorDir(), FILE_NAME);
}

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
    console.warn('[install-id] ' + fp + ' 内容不是合法 UUID，拒绝覆盖（请人工处置）：' + JSON.stringify(id.slice(0, 40)));
    return null;
  } catch (e) {
    if (e && e.code !== 'ENOENT') {
      console.warn('[install-id] 读取失败（不新建，避免标识漂移）：' + e.message);
      return null;
    }
  }

  try {
    const dir = path.dirname(fp);
    fs.mkdirSync(dir, { recursive: true });
    const id = crypto.randomUUID();
    writeAtomic(fp, id + '\n', { mode: 0o600 });
    _cached = { id: id.toLowerCase(), source: 'created' };
    return _cached;
  } catch (e) {
    console.warn('[install-id] 生成/落盘失败（本次无标识）：' + e.message);
    return null;
  }
}

function installId() {
  const r = readInstallId();
  return r ? r.id : null;
}

function _resetCache() { _cached = null; }

module.exports = { installId, readInstallId, installIdPath, FILE_NAME, ENV_OVERRIDE, UUID_RE, _resetCache };
