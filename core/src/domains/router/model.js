'use strict';

// 反代实例模型：一个账号（key）= 一个实例（硬规则）。实例态四态：COLD 未启动（资源 0）、
// WARM 启动中（有进程未就绪，不可服务）、HOT 就绪、DEAD 进程在但不健康（待回收）。
// 账号级冻结不在实例态里（冻结是账号语义，base/freeze 管理）。pid 不落盘；端口绑定在账号可用
// 且有槽位期间保留（防漂移），进等待区或被删除时随进程一并归零（LC 核心-3：等待区零进程零端口）。

/** 实例四态（本域唯一实例态词表，冻结）。 */
const INSTANCE_STATES = Object.freeze({
  COLD: 'COLD', WARM: 'WARM', HOT: 'HOT', DEAD: 'DEAD',
});

// 纯谓词（参数显式化）：实例方法的唯一事实源，供无实例句柄的纯代码复用。

/** 实例是否可立即服务：态为 HOT 且 pid 在（pid 是运行期事实，不落盘）。 */
function isServable(inst) {
  return !!inst && inst.status === INSTANCE_STATES.HOT && !!inst.pid;
}

/** 实例是否占用资源（WARM/HOT/DEAD 都有进程）。槽位预算据此计数（LC 核心-2：期望集 <= 在用 1 + 预热 1）。 */
function occupiesSlot(inst) {
  return !!inst && (inst.status === INSTANCE_STATES.WARM
    || inst.status === INSTANCE_STATES.HOT || inst.status === INSTANCE_STATES.DEAD);
}

/** 落盘形状（pid 不落盘；port 持久化）。 */
function serializeInstance(inst) {
  return {
    key: inst.key,
    keyId: inst.keyId,
    maskedKey: inst.maskedKey,
    status: inst.status,
    healthy: inst.healthy,
    quota: inst.quota,
    registeredAt: inst.registeredAt,
    version: inst.version || null,
    port: inst.port || null,
  };
}

class ProxyInstance {
  constructor(opts) {
    this.key = opts.key || null;
    this.keyId = opts.keyId;
    this.maskedKey = opts.maskedKey;
    this.app = opts.app || null;
    this.logger = opts.logger || console;
    this.events = opts.events || null;
    this.onEvent = opts.onEvent || null;
    this.status = INSTANCE_STATES.COLD;
    this.healthy = false;
    this.quota = null;
    this.registeredAt = Date.now();
    this.pid = null;
    this.port = null;
    // 载体身份（run.pid 文件 + cmdline 锚点）：仅本代运行期内存有效，不落盘；跨代残尸走端口幸存者弃用链。
    this.pidFile = null;
    this.launchAnchors = null;
    this.version = null;
    this.startingPromise = null; // 启动并发去重：启动中复用同一 Promise，杜绝双 spawn
    this._unhealthyCount = 0;  // 连续不健康次数（运行时，不落盘——健康监护用：>=N 次自动重启）
    this._restartAt = 0;       // 自动重启退避时刻（防风暴）
    this._monitorFails = 0;    // 健康监测连续失败次数（与 _unhealthyCount 独立，见 process-pool.js 计数纪律）
    this._lastProblem = null;  // 最近一次实例级问题原因（诊断）
    this._restartPending = null; // 在途请求期间被延后的重启原因（由 flushRestartPending 消费）
  }

  toJSON() { return serializeInstance(this); }

  /** 实例是否可立即服务（切换策略唯一需要问的问题）。 */
  isServable() { return isServable(this); }

  occupiesSlot() { return occupiesSlot(this); }

  static fromJSON(o) { return deserializeInstance(o); }
}

/** 反序列化：恢复绑定端口（防漂移）+ version/quota；pid 清零、态回 COLD。 */
function deserializeInstance(o) {
  const i = new ProxyInstance({ key: o.key || null, keyId: o.keyId, maskedKey: o.maskedKey });
  i.status = INSTANCE_STATES.COLD;
  i.healthy = false;
  i.quota = o.quota || null;
  i.registeredAt = o.registeredAt || Date.now();
  i.version = o.version || null;
  i.port = o.port || null;
  return i;
}

module.exports = { ProxyInstance, INSTANCE_STATES, isServable, occupiesSlot, serializeInstance, deserializeInstance };
