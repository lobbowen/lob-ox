'use strict';

// 领域模型：实例记录形状与迁移、视图行组装、任务状态词表。纯函数，零 IO、零隐式 this；
// 视图行的 IO 结果（版本/作业/探测）由调用方解析后传入。
const { semverCompare } = require('../../shared/version');
/** 任务状态 -> 前端契约词表。与 plugin/model.taskStateToJobState、router/ops/apps-registry 的
 *  proxyUpdateStatus 是有意平行（映射分支完全一致）：三处属三个域，抽取须三处同批改动，故不抽公共函数。 */
function taskStateToView(s) {
  return (s === 'succeeded' || s === 'skipped') ? 'done' : (s === 'failed' || s === 'canceled') ? 'failed' : 'running';
}

/** 磁盘文档实例记录 -> 运行时记录（纯迁移，不落盘）：dshToken/remoteEnabled/frpEnabled/frpRemotePort/wanPort 一律剔除，
 *  legacy 布尔对推导 remoteMode 三态（端口权威在 relay 槽位注册表）；guardian 缺省关；
 *  重启后 FAILED 一律重置 STOPPED（失败是一次性状态）；desired（运行意图第二落点）已废止，残留一次性剔除。
 *  令牌源登记（tokens.attach）是 IO，留在 store.load()，不进本函数。 */
function normalizeInstance(inst) {
  if (Object.prototype.hasOwnProperty.call(inst, 'dshToken')) delete inst.dshToken;
  if (inst.remoteMode !== 'lan' && inst.remoteMode !== 'wan') {
    inst.remoteMode = inst.remoteEnabled === true ? (inst.frpEnabled === true ? 'wan' : 'lan') : 'off';
  }
  delete inst.remoteEnabled;
  delete inst.frpEnabled;
  delete inst.frpRemotePort;
  delete inst.wanPort;
  // 用户填额链已废止：历史记录残留的 memoryMax/cpuQuota 一律剔除，防「删了入口但旧值仍被读」的静默配额漂移。
  if (inst.sandbox) { delete inst.sandbox.memoryMax; delete inst.sandbox.cpuQuota; }
  if (inst.guardian === undefined) inst.guardian = false;
  if (inst.state && inst.state.phase === 'FAILED') {
    inst.state.phase = 'STOPPED';
    inst.state.lastError = null;
  }
  if (inst.state) inst.state.phase = inst.state.phase || 'STOPPED';
  // 运行意图不设第二落点（B2-1）：自动拉起只认 guardian 开关，用户启停就是动作本身。
  //  历史库里残留的 desired 一次性剔除，与上面 legacy 布尔对的剔除同惯例——字段没了就是没了。
  if (inst.state) delete inst.state.desired;
  return inst;
}

/** 新增实例记录（payload 规范化）；端口合法性/占用探测等编排在 ops.js。 */
function createRecord(payload, id) {
  const port = parseInt(payload.port, 10);
  return {
    id,
    name: String(payload.name || ('实例:' + port)).slice(0, 40),
    port,
    domain: 'sandbox',
    kind: 'sandbox',
    autoRegistered: false,
    createdBy: 'user',
    command: Array.isArray(payload.command) ? payload.command : [],
    guardian: !!payload.guardian, // 进程守护(自动拉起)开关默认关（架构红线：未显式开启绝不自动拉起）
    remoteMode: payload.remoteMode === 'lan' || payload.remoteMode === 'wan' ? payload.remoteMode : 'off',
    remoteToken: String(payload.remoteToken || ''),
    unitName: 'dsh-web@' + id,
    sandbox: {
      privateTmp: true,
      // node/dsh 位于 /home（nvm），ProtectHome=yes 会使其 exec 失败(203/EXEC)；默认关闭，可用 payload.protectHome 覆盖
      protectHome: payload.protectHome === undefined ? false : !!payload.protectHome,
      // 资源配额不接收户输入：启动时由 governor 按机器预算与活跃实例数推导。
    },
    state: { phase: 'STOPPED', restartCount: 0, backoffLevel: 0, lastProbeOk: null },
    createdAt: new Date().toISOString(),
  };
}

/** 单实例映射到前端契约行（纯）。resolved = { version, latest, updateJob, probe } 均为调用方解析好的 IO 结果。 */
function viewRow(inst, resolved) {
  const version = resolved.version;
  const latest = resolved.latest;
  return {
    id: inst.id,
    name: inst.name,
    port: inst.port,
    domain: inst.domain || 'native',
    kind: inst.kind || inst.domain || 'native',
    guardian: inst.guardian,
    remoteMode: inst.remoteMode || 'off',
    unitName: inst.unitName,
    sandbox: inst.sandbox,
    // 沙箱实例版本与更新（每实例独立 DSH 安装；native 无独立安装，返回 null 不显示）
    version,
    latest,
    updateAvailable: !!(latest && version && semverCompare(latest, version) > 0),
    updateJob: resolved.updateJob,
    state: Object.assign({}, resolved.probe, {
      // 沙箱生命周期（可观测）：lifecyclePhase 为内部状态机相位，lastError 暴露失败原因
      lifecyclePhase: inst.state ? inst.state.phase : 'STOPPED',
      lastError: inst.state ? inst.state.lastError : null,
      // 当次启动生效的动态配额（governor 推导；未启动过为 null）
      allocation: inst.state ? (inst.state.allocation || null) : null,
      // 实测占用（W2 监督拍回填 { memMb, cpuPct, at }；未采到/已停止为 null，与 allocation 成对展示）
      usage: inst.state ? (inst.state.usage || null) : null,
      // 稳定性统计（与原生卡一致）：重启次数 / 最近故障原因（BACKOFF/FAILED 由状态机记录）
      restartCount: inst.state ? (inst.state.restartCount || 0) : 0,
      lastFailure: inst.state ? (inst.state.lastFailure || null) : null,
      installing: inst.state && inst.state.phase === 'INSTALLING',
      installOk: inst.state ? inst.state.installOk : undefined,
      installError: inst.state ? inst.state.installError : undefined,
      installLog: inst.state ? (inst.state.installLog || []) : [],
    }),
  };
}

module.exports = { taskStateToView, normalizeInstance, createRecord, viewRow };
