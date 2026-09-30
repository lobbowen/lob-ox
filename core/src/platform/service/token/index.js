'use strict';

// 令牌组件门面（DSH-TOKEN-CONTRACT 契约3/4），全系统唯一令牌节点，入口保持 platform/service/token；消费方只做两件事：attach 登记来源、
// 订阅 onChange 消费令牌，捕获策略（退避重试、周期回填、轮换收敛）在组件内统一实现，调用方不复制逻辑。兼容面：get/onChange/attach/detach/capture/
// feedLine/scheduleCapture/ensureCaptured/clear 语义不变，onChange 新增第 3 参 record。TK-1 令牌恒存在 / TK-4 单一存储（本池即 SSOT，按需 get）/ TK-5 单一落盘点 persist.js / TK-6 超限轮转 / TK-8 变更与失效都广播。

const { TokenPool } = require('./pool');
const { parseDshTokenLine } = require('./capture');

/** 令牌服务门面（契约4 冻结 API）；实现分层在 pool/capture/persist/follow/kinds，本类只做转发。 */
class DshTokenService {
  /** @param {object} opts { logger, events, poolFile }；poolFile 不传则不落盘池快照。 */
  constructor(opts) {
    const o = opts || {};
    this.logger = o.logger || console;
    this.events = o.events || null;
    this.pool = new TokenPool({ logger: this.logger, events: this.events, poolFile: o.poolFile || null });
  }

  /** 登记源。kind 必填（契约1）；缺省时按源形态强推断（见 pool.inferKind）。 */
  attach(id, src) { return this.pool.attach(id, src); }
  /** 注销源并清令牌，广播 null（TK-8）。 */
  detach(id) { return this.pool.detach(id); }

  /** 主动捕捉一次（journal 源）。返回当前令牌或 null。 */
  capture(id) { return this.pool.capture(id); }
  /** DSH stdout 行事件（同步命中即入池并广播）。 */
  feedLine(id, line) { return this.pool.feedLine(id, line); }
  /** 进入 RUNNING 后窗口内退避重试。 */
  scheduleCapture(id) { return this.pool.scheduleCapture(id); }
  /** 周期兜底（节流）。 */
  ensureCaptured(id) { return this.pool.ensureCaptured(id); }

  /** 清令牌，广播 null（TK-8）。 */
  clear(id) { return this.pool.clear(id); }
  /** 订阅令牌变化：fn(id, value|null, record)。返回取消订阅函数。 */
  onChange(fn) { return this.pool.onChange(fn); }

  /* 读取（消费方按需读，禁止缓存，TK-4） */
  /** 当前令牌值（空串表示未捕获到）。 */
  get(id) { return this.pool.get(id); }
  /** 当前令牌记录（含"代"）{ value, gen, source, at } | null。 */
  getRecord(id) { return this.pool.getRecord(id); }
  /** 展示用列表，不含用户配置类（TK-7）。 */
  list() { return this.pool.list(); }
}

// 契约4 冻结导出面：只导出 DshTokenService 与 parseDshTokenLine；KINDS 等内部表不外泄，
// 避免消费方绕开服务直接读写分类；需按 kind 分派者显式 require ./kinds。
module.exports = {
  DshTokenService,
  parseDshTokenLine, // 全仓唯一解析实现，由 capture.js 提供
};
