'use strict';

/**
 * 跨语言共享常量的 Node 侧读取口（决策 D4 / X1）。
 *
 * 与 shell/src-tauri/src/brand.rs 的 `include_str!("../../../shared/shared-constants.json")`
 * 指向**同一个文件**。两侧都不再各存一份副本 ⇒ 结构上不可能漂移。
 *
 * 只在**进程首次读取**时解析一次并冻结，之后零成本。
 */
const fs = require('node:fs');
const path = require('node:path');

const FILE = path.resolve(__dirname, '..', '..', '..', 'shared', 'shared-constants.json');

const RAW = JSON.parse(fs.readFileSync(FILE, 'utf8'));

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
});
