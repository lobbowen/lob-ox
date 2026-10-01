'use strict';

const BRAND = require('../../../shared/brand');

const LOCAL_SOURCE = 'guard';
const _sources = [];

function normalizeSource(name, opts) {
  const o = opts || {};
  if (typeof name !== 'string' || !name.trim()) return null;
  return { name, key: (typeof o.key === 'string' && o.key) ? o.key : name, local: o.local === true };
}

function registerSource(name, opts) {
  const s = normalizeSource(name, opts);
  if (!s) return false;
  const i = _sources.findIndex((x) => x.name === s.name);
  if (i >= 0) _sources[i] = s; else _sources.push(s);
  return true;
}

function registerSources(list) {
  for (const it of (Array.isArray(list) ? list : [])) {
    if (typeof it === 'string') registerSource(it);
    else if (it && typeof it === 'object') registerSource(it.name, it);
  }
}

function setSources(list) { _sources.length = 0; registerSources(list); }

function resolvedSources() {
  if (_sources.length) return _sources.slice();
  return [normalizeSource(LOCAL_SOURCE, { local: true })];
}

const _internalTypes = new Set();
function registerInternalType(type) { const t = String(type || ''); if (t) _internalTypes.add(t); }
function setInternalTypes(list) { _internalTypes.clear(); for (const t of (Array.isArray(list) ? list : [])) registerInternalType(t); }

function isInternalEvent(type) {
  const t = String(type || '');
  if (t.startsWith('shadow_') || t.startsWith('managed_object_')) return true;
  return _internalTypes.has(t);
}

function humaneMsg(type, data) {
  const d = data || {};
  const who = d.id === 'main' ? '主实例' : (d.id || '会话');
  switch (type) {
    case 'lan_cookie_exchanged': return who + ' 远程会话 cookie 已刷新';
    case 'lan_cookie_failed': return who + ' 远程会话 cookie 换取失败' + (d.error ? '：' + d.error : '');
    case BRAND.EVENT_HARNESS_TOKEN_CAPTURED: return who + ' DSH 令牌已捕获';
    case BRAND.EVENT_HARNESS_TOKEN_MISSING: return who + ' DSH 令牌缺失，等待捕获';
    case 'inst_added': return '新增沙箱实例：' + (d.id || '?');
    case 'inst_removed': return '删除沙箱实例：' + (d.id || '?');
    case 'inst_started': return '沙箱实例已启动：' + (d.id || '?');
    case 'inst_stopped': return '沙箱实例已停止：' + (d.id || '?');
    case 'inst_failed': return '沙箱实例失败：' + (d.reason || d.lastError || d.error || '?');
    case 'upgrader_started': return '开始升级 DSH' + (d.version ? ' 至 ' + d.version : '');
    case 'upgrader_done': return 'DSH 升级完成' + (d.version ? '，当前 ' + d.version : '');
    case 'upgrader_failed': return 'DSH 升级失败：' + (d.error || '未知原因');
    case 'upgrade_installed': return 'DSH ' + (d.version || '?') + ' 已安装';
    case 'api_failed': return 'API 请求失败：' + (d.error || d.message || '未知');
    default: return null;
  }
}

module.exports = {
  LOCAL_SOURCE, registerSource, registerSources, setSources,
  resolvedSources, registerInternalType, setInternalTypes, isInternalEvent, humaneMsg,
};
