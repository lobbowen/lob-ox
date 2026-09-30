'use strict';

// 镜像配置的载入与持久化（IO）。这里定的规则是**所有权**：哪份文件由谁写，就只由谁写。
//   <产品状态根>/supervisor/registry.json         壳有，内核只读（契约：镜像目录 + 探测规格 + 测速证据）
//   <产品状态根>/supervisor/registry-choice.json  内核有，唯一写者（选择：mode / 手动源 / 用户候选）
// 拆成两份之前，两者同居 registry.json：内核每次保存都要「读回原文、只覆盖自己那三键」来避免抹掉壳字段，
// 而壳为了避免反向抹掉内核的 manual 意图干脆在检测到 mode=manual 时**不再更新整份契约** —— 于是用户在
// 面板固定过一次源之后，镜像目录与探测规格就永久停在那一刻，壳升级也不会刷新。两个写者一份文件，
// 谁都没有干净的解法，只能互相让步；拆开之后两边各写各的，两个让步一起删掉。
// 与 registry.js（探测与选源）分开：那里回答「本次用哪个源」，这里只管读与写。

const fs = require('node:fs');
const path = require('node:path');
const registryContract = require('../contract/registry');
const { writeAtomic } = require('../util/fs');
const policies = require('./policies');

/** 壳投放契约的重载 TTL（ms）：壳会在运行中重写 registry.json，内核必须能看到。 */
const CONTRACT_TTL_MS = 60 * 1000;

/** 内核选择文档的 schema。 */
const CHOICE_SCHEMA = 1;

/** 读内核自己的选择文档。区分「没有」（首次运行，需要迁移）与「有但读不动」（不据此迁移，
 *  免得把一个损坏的文件当成升级前现场，把旧契约里的字段再灌一遍）。 */
function readChoiceDoc(file) {
  if (!file) return { status: 'absent', doc: null };
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return { status: 'absent', doc: null }; }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { status: 'bad', doc: null };
    return { status: 'ok', doc: parsed };
  } catch { return { status: 'bad', doc: null }; }
}

/** 载入镜像配置：先读壳契约（只读），再读内核选择文档；两者都缺时按默认值起步。
 *  候选列表优先级见 policies.effectiveOrigins（用户显式候选 > 契约目录 > 兜底）。
 *  契约不可用时不阻断：记录 reason 供诊断，选择路径自动回退（不变量 C2）。 */
function loadRegistryConfig(state) {
  state.contract = registryContract.read(state.registryFile);
  if (!state.contract.ok) {
    state.logger.warn && state.logger.warn(
      'dist: 镜像契约不可用（' + state.contract.reason + '），回退到最小兜底（' +
      (state.defaultRegistries || []).length + ' 条）'
    );
    if (state.events) {
      try {
        state.events.append('dist_contract_unavailable', {
          reason: state.contract.reason, file: state.registryFile,
        });
      } catch { /* 事件失败不阻断 */ }
    }
  }
  const choice = readChoiceDoc(state.choiceFile);
  if (choice.status === 'bad' && state.logger.warn) {
    state.logger.warn('dist: 镜像选择文档不可解析，按默认配置起步: ' + state.choiceFile);
  }
  if (choice.status === 'ok') {
    state.registryConfig = policies.rebuildRegistryConfig(choice.doc);
    return;
  }
  // 首次运行（或从旧版升级上来的第一次）：旧契约里带着内核当年写进去的 manual 意图，迁一次并落盘，
  // 之后契约里那些字段就不再被读过 —— 壳升到 schema3 会把它们删掉。
  const legacy = state.contract.ok ? state.contract.legacyChoice : null;
  state.registryConfig = policies.rebuildRegistryConfig(legacy || null);
  if (legacy) {
    saveRegistryConfig(state);
    if (state.events) {
      try {
        state.events.append('dist_registry_choice_migrated', {
          mode: state.registryConfig.mode, manualOrigin: state.registryConfig.manualOrigin,
        });
      } catch { /* 事件失败不阻断 */ }
    }
  }
}

/** 距上次载入超过 CONTRACT_TTL_MS 则重载壳投放的镜像契约。不用 fs.watch：无句柄泄漏、
 *  跨平台一致，60s 新鲜度对低频的镜像选择足够。 */
function reloadContractIfStale(state) {
  const now = Date.now();
  if (state._contractLoadedAt && (now - state._contractLoadedAt) < CONTRACT_TTL_MS) return;
  loadRegistryConfig(state);
  state._contractLoadedAt = now;
}

/** 落盘内核的选择文档。**契约文件不在本函数的写面内**（它由壳拥有）：一旦这里出现契约路径，
 *  两个写者的老问题就会回来，所以本文件对 registryFile 只做读。 */
function saveRegistryConfig(state) {
  if (!state.choiceFile) return; // 只读挂载（如反代 daemon）：没有写路径可言
  const rc = state.registryConfig || {};
  try {
    const dir = path.dirname(state.choiceFile);
    if (dir && !fs.existsSync(dir)) { try { fs.mkdirSync(dir, { recursive: true }); } catch { /* 建目录失败不阻断 */ } }
    const doc = {
      schema: CHOICE_SCHEMA,
      updatedAt: Math.floor(Date.now() / 1000),
      mode: rc.mode === 'manual' ? 'manual' : 'auto',
      manualOrigin: typeof rc.manualOrigin === 'string' ? rc.manualOrigin : '',
      origins: Array.isArray(rc.origins) ? rc.origins.slice() : [],
    };
    writeAtomic(state.choiceFile, JSON.stringify(doc, null, 2) + '\n', { mode: 0o600 });
  } catch (e) {
    state.logger.warn && state.logger.warn('dist: registry choice save failed: ' + e.message);
  }
}

module.exports = {
  CONTRACT_TTL_MS,
  CHOICE_SCHEMA,
  loadRegistryConfig,
  reloadContractIfStale,
  saveRegistryConfig,
};
