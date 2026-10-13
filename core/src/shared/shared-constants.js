'use strict';

const RAW = require('../../../shared/shared-constants.json');

if (RAW.schema !== 1) {
  throw new Error('shared-constants: 不支持的 schema ' + RAW.schema + '（期望 1）');
}

module.exports = Object.freeze({
  schema: RAW.schema,
  product: Object.freeze(RAW.product),
  state: Object.freeze(RAW.state),
  env: Object.freeze(RAW.env),
  proc: Object.freeze(RAW.proc),
  bridge: Object.freeze(RAW.bridge),
  net: Object.freeze({
    apiPort: RAW.net.apiPort,
    routerCtlPort: RAW.net.routerCtlPort,
    lanCtlPort: RAW.net.lanCtlPort,
    deprecatedApiPorts: Object.freeze(RAW.net.deprecatedApiPorts.slice()),
    dshDefaultPort: RAW.net.dshDefaultPort,
  }),
  runtime: Object.freeze(RAW.runtime),
  // R8 跨层收口：以下四段原先在 shell/src-tauri/src/brand.rs 与 core/src/shared/brand.js
  // 各自硬编码一份副本，改一侧漏一侧。现统一走本文件（Rust 侧 include_str! 编译期嵌入）。
  packaging: Object.freeze(RAW.packaging),
  // platform 段只有 cliBinNames 是数组，slice() 冻结；其余是标量，整段 freeze。
  platform: Object.freeze({
    ...RAW.platform,
    cliBinNames: Object.freeze(RAW.platform.cliBinNames.slice()),
  }),
  event: Object.freeze(RAW.event),
  store: Object.freeze(RAW.store),
});
