'use strict';

// app/settings/domain-config.js —— 业务域配置键声明（默认值 + 换名别名）。
// 反转法：platform/ 源码不得出现业务域名词，业务键的默认值与别名在此声明，
//   由各进程入口/装配期注入 config.normalize / buildDefaults。
// 纪律：只做数据声明（纯对象/数组），零副作用；绝不 require platform/service/config（成环）。

/** 业务域默认值声明：值须与 `platform/service/config.js BASE_DEFAULTS` 的同名字面量一致（逐字）。
 *  `at` = 锚点键：本组值插入到 BASE_DEFAULTS 中该键之前（保持 DEFAULTS 键序稳定）。 */
const defaults = [
  {
    at: 'portPools',
    // daemon 控制通道端口：集中定义，杜绝散落硬编码。
    // 这两个值同时是 app/ctl/client.js 与两个 daemon 的兜底端口，不得单独改动
    //   （改动即需同步 8 处 43107/43108 兜底常量）。
    values: {
      routerCtlPort: 43107,
      lanCtlPort: 43108,
    },
  },
  {
    at: 'corePackageName',
    // 智能路由启动开关。
    values: {
      routerAutostart: false,
    },
  },
];

/** 换名别名表：[旧键, 新键]，平台通用迁移机制（config.normalize 逐条应用）。
 *  新键缺省且旧键已给时，布尔严格归一后写入新键。 */
const aliases = [
  ['switcherAutoStart', 'routerAutostart'],
];

/** 实例化一个完整注入声明（浅拷贝，防调用方改写本模块的常量）。 */
function extension() {
  return {
    defaults: defaults.map((g) => ({ at: g.at, values: Object.assign({}, g.values) })),
    aliases: aliases.map((a) => a.slice()),
  };
}

module.exports = { extension, defaults, aliases };
