'use strict';

const { shared: portsShared } = require('../../platform/service/ports');
const { OWNER_PREFIXES } = require('./port-segments');

// router 域端口迁移 + 按 providers 重建端口绑定。IO 编排、幂等合并；必须在 RouterService 构造
// 之前调用，否则构造时 configureFile 加载不到完整文件，内存空表会覆盖历史绑定（真实数据丢失）。

const path = require('node:path');
const fs = require('node:fs');
const { writeAtomic } = require('../../platform/util/fs');

/** 迁移 router 自治端口段（proxy/providerApi）到 ports-router.json，并按 providers.json 重建绑定。
 *  入参显式化：{ swDir, logger }。返回 { records } 供观察；异常内部吞掉并记日志（保留旧文件）。 */
function ensurePorts({ swDir, logger }) {
  const log = logger || console;
  try {
    // 迁移由域知识驱动：本域申报自己的 owner 前缀，平台只做通用前缀迁移（无域名词）。
    const oldP = path.join(swDir, 'ports.json');
    const newP = path.join(swDir, 'ports-router.json');
    portsShared.migrateByOwnerPrefix(oldP, newP, OWNER_PREFIXES);
    // 从 providers.json 重建 proxy/providerApi 段绑定（覆盖迁移期因覆盖而丢失的记录；幂等合并）
    const provFile = path.join(swDir, 'providers.json');
    if (fs.existsSync(provFile)) {
      const provs = JSON.parse(fs.readFileSync(provFile, 'utf8'));
      let target = { records: [] };
      try { if (fs.existsSync(newP)) target = JSON.parse(fs.readFileSync(newP, 'utf8')); } catch {}
      const byOwner = {};
      for (const rec of target.records || []) byOwner[rec.owner] = rec.port;
      let changed = false;
      const push = (owner, port, role) => { if (port && byOwner[owner] === undefined) { target.records.push({ port, role, owner, createdAt: Date.now() }); byOwner[owner] = port; changed = true; } };
      for (const p of (provs.providers || [])) {
        // 此处遍历的是 providers.json 的落盘原始记录（无原型方法）：kind 是持久化鉴别器、
        // 唯一可用判据（supports 能力面只存在于运行期 provider 对象上）。
        if (p.kind !== 'proxy') continue;
        for (const inst of (p.instances || [])) push('proxy:' + (inst.keyId || inst.key), inst.port, 'proxyInstance');
        push('providerApi:' + p.id, p.apiPort, 'providerApi');
      }
      if (changed) {
        fs.mkdirSync(path.dirname(newP), { recursive: true });
        writeAtomic(newP, JSON.stringify(target, null, 2), { mode: 0o600 });
      }
    }
    const cnt = JSON.parse(fs.readFileSync(newP, 'utf8')).records || [];
    log.info('[router-daemon] 迁移S2+重建：ports-router.json 就绪 records=' + cnt.length);
    return { records: cnt.length };
  } catch (err) {
    log.error('[router-daemon] 迁移S2 异常(保留旧文件): ' + ((err && err.message) || err));
    return { records: 0, error: err };
  }
}

module.exports = { ensurePorts };
