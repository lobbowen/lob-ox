'use strict';

// 转发门面（组合 + 导出），不承载业务逻辑：组合 handlers/parse + handlers/forward +
// store/usage + model/inflight；createForwardCore(deps) 显式注入依赖，装配边界唯一，
// 不调用 this.<index方法>。

const { keyFingerprint, maskKey } = require('./providers/base');
const parse = require('./handlers/parse');
const { joinUpstream } = parse;
const { createForwarder } = require('./handlers/forward');
const { UsageLedger } = require('./store/usage');
const { createInflight } = require('./model/inflight');

function createForwardCore(deps) {
  const d = deps || {};
  const usage = new UsageLedger({
    file: d.usageTotalsFile,
    canPersist: d.canPersist,
    keyFingerprint: d.keyFingerprint || keyFingerprint,
    estimateCost: parse.estimateCost,
    events: d.events,
    logger: d.logger,
  });
  const inflight = createInflight();
  const forwarder = createForwarder({
    log: d.log, logger: d.logger, readBody: parse.readBody,
    parse, usage, inflight, switcher: d.switcher, events: d.events,
    getPricing: d.getPricing, agents: d.agents, maskKey,
  });
  return { proxyFor: forwarder.proxyFor, writeThrough: forwarder.writeThrough, forwardOnce: forwarder.forwardOnce, endInflight: forwarder.endInflight, recordError: forwarder.recordError, usage, inflight };
}

module.exports = { createForwardCore, maskKey, joinUpstream };
