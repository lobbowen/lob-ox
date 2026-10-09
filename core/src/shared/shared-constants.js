'use strict';

/**
 * 跨语言共享常量的 Node 侧读取口（决策 D4 / X1）。
 *
 * 与 shell/src-tauri/src/brand.rs 的 include_str!("../../../shared/shared-constants.json")
 * 指向**同一个文件**。两侧都不再各存一份副本 ⇒ 结构上不可能漂移。
 *
 * 用静态 require 而非运行时 fs.readFileSync：esbuild 打包期即把该 JSON 内联进 core.cjs，
 * 运行期零文件依赖（不依赖 __dirname 的相对层数，跨平台打包一致）；未打包的开发/测试态下
 * Node 仍直接解析仓库根 shared/shared-constants.json。范式取自 shell/shell-release/version-vectors.json
 * （本仓已验证的跨语言单源先例）。
 */
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
});
