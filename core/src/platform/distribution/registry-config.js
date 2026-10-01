'use strict';

const fs = require('node:fs');
const path = require('node:path');
const registryContract = require('../contract/registry');
const { writeAtomic } = require('../util/fs');
const policies = require('./policies');

const CONTRACT_TTL_MS = 60 * 1000;

const CHOICE_SCHEMA = 1;

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
      } catch {  }
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
  const legacy = state.contract.ok ? state.contract.legacyChoice : null;
  state.registryConfig = policies.rebuildRegistryConfig(legacy || null);
  if (legacy) {
    saveRegistryConfig(state);
    if (state.events) {
      try {
        state.events.append('dist_registry_choice_migrated', {
          mode: state.registryConfig.mode, manualOrigin: state.registryConfig.manualOrigin,
        });
      } catch {  }
    }
  }
}

function reloadContractIfStale(state) {
  const now = Date.now();
  if (state._contractLoadedAt && (now - state._contractLoadedAt) < CONTRACT_TTL_MS) return;
  loadRegistryConfig(state);
  state._contractLoadedAt = now;
}

function saveRegistryConfig(state) {
  if (!state.choiceFile) return;
  const rc = state.registryConfig || {};
  try {
    const dir = path.dirname(state.choiceFile);
    if (dir && !fs.existsSync(dir)) { try { fs.mkdirSync(dir, { recursive: true }); } catch {  } }
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
