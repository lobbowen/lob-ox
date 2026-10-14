'use strict';

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
  // 只暴露本域真实消费的转发面：writeThrough / forwardOnce 全仓零引用
  // （forwardOnce 仅供本文件 createForwarder 内部的 callUpstream 使用），
  // 暴露它们等于把「可绕过 proxyFor 的转发入口」留在公开面上。
  return { proxyFor: forwarder.proxyFor, endInflight: forwarder.endInflight, recordError: forwarder.recordError, usage, inflight };
}

module.exports = { createForwardCore, maskKey, joinUpstream };
