'use strict';

// app/control/managed-object.js —— 受管对象目录的纯模型（词表 + entry + 所有权）。
// 零 IO、零 this，可独立单测。PHASES 的字面量唯一源必须在 registry.js（其导出面 re-export 本模块）。

/** desired 唯一取值（用户意图）。与 guardian（自动拉起策略）是两个正交轴。 */
const DESIRED = ['running', 'stopped'];

/** 受管对象类型表（显式、稳定，不造通用 CRD；扩展经 registerKind 声明能力）。 */
const MANAGED_KINDS = {
  dsh:              { label: '原生 DSH',       startable: true, guardable: true },
  'sandbox-instance': { label: '沙箱实例',     startable: true, guardable: true },
  'router-daemon':  { label: '智能路由 daemon', startable: true, guardable: true },
  'lan-daemon':     { label: '远程控制 daemon', startable: true, guardable: true },
  plugin:           { label: '插件（聚合）',    startable: false, guardable: false },
};

let _customKinds = {};

function kindMeta(kind) {
  return MANAGED_KINDS[kind] || _customKinds[kind] || null;
}

/** 注册新类型能力（显式声明，非 CRD）。 */
function registerKind(kind, meta) {
  _customKinds[kind] = Object.assign({ label: kind, startable: false, guardable: false }, meta || {});
}

/** 受管对象目录项（应然 + 所有权；phase 由调谐驱动，观测不入册）。 */
function createEntry(o) {
  const meta = kindMeta(o.kind);
  if (!meta) throw new Error('未知受管对象类型: ' + o.kind + '（先 registerKind 声明）');
  if (!o.id || typeof o.id !== 'string') throw new Error('注册项缺少 id');
  return {
    kind: o.kind,
    id: o.id,
    name: String(o.name || o.id),
    // desired 两域共用字段名但语义不同：域 A=用户意图；域 B=「当前业务是否需要它」的条件
    desired: (o.desired === 'stopped') ? 'stopped' : 'running',
    // guardian 开关的权威在域记录本身（dsh-main.json / inst.guardian），消费者全部直读源；
    //  目录曾在域 A entry 上物化该字段但零读者（B2-2 收口）。createEntry 永不物化 guardian 键
    //  = 老库残留的天然一次性清理口（load 经本函数重建即消失），无需迁移脚本。
    ownership: normalizeOwnership(o.ownership),
    // 初始 stopped；业务不得直接改，由 heartbeat 调谐循环写入
    phase: 'stopped',
    lastObserved: null, // 实然缓存 { ok, error, at }；不持久化，由 heartbeat/adapter 写入
    // 运行期引用（不持久化）：main 状态机句柄，形如 { child?, adoptedPid?, adopted, observedOnly, startDeadline?, spawnBlockedUntil? }
    process: null,
    // daemon 类黑盒经 ctl 呈报的紧凑摘要，只读缓存不持久化（形如 { runState, providers, accounts, proxyInstances, resourcePorts, fetchedAt }）
    domainSummary: null,
    // 退避与崩溃窗口计数随目录持久化（见 registry _load/_save）
    backoffLevel: 0,
    backoffUntil: null,
    crashWindowStart: null,
    crashWindowRestarts: 0,
    restartCount: 0,
    startedAt: null,
    lastTransitionAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function normalizeOwnership(own) {
  const o = own || {};
  const ports = Array.isArray(o.ports) ? o.ports
    .filter((p) => p && Number.isInteger(Number(p.port)) && p.port > 0)
    .map((p) => ({ role: String(p.role || 'default'), port: Number(p.port) })) : [];
  return {
    ports,
    rootPath: o.rootPath ? String(o.rootPath) : null,
    unit: o.unit ? String(o.unit) : null,
    daemonScript: o.daemonScript ? String(o.daemonScript) : null,
    processMode: ['spawn', 'systemd', 'daemon', 'adopted'].includes(o.processMode) ? o.processMode : null,
    meta: (o.meta && typeof o.meta === 'object') ? Object.assign({}, o.meta) : null, // 域备注（只读参考）
  };
}

module.exports = { DESIRED, MANAGED_KINDS, kindMeta, registerKind, createEntry, normalizeOwnership };
