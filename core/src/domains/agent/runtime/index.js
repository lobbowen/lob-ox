'use strict';

// agent 运行时层：把「形态差异」吸收掉，向上提供同一套启停/入口/env 能力。
//
// 当前只实现数据隔离（env 重定向 + 独立目录）。
// 容器化隔离不在此层——按既定决策，agent 之间只需各自独立数据目录，
// 不需安全隔离，故不引入容器运行时。

const sandboxEnv = require('./sandbox-env');

module.exports = { sandboxEnv };