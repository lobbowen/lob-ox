'use strict';

// api —— 本地 HTTP API 门面：re-export 网关 createServer（实现 ./transport/server.js）与安全判定三函数（实现 ./security.js）。
// 安全边界：默认仅回环绑定（开启局域网访问后局域网内设备可访问面板/API）；只允许本机（回环）与 RFC1918 私有 IP 的 Host/Origin，外部/公网主机被拒；
// CORS 头仅对桌面壳来源（tauri:// / *.tauri.localhost）返回，其他 Origin 零 CORS，带 Origin 的写请求必须来自本机/局域网面板来源，外部网页无法驱动 start/stop/upgrade。导出面逐字保持（api-contract / api-security / lan-access-boundary / defects-batch-f 依赖；原 api-surface 与 core-test 已于 2026-10-01 移除）。

const { createServer } = require('./transport/server');

// 兼容 re-export（不得移除）：测试直调 originAllowed / isLoopbackHost / isShellOrigin 做行为断言，仅源码正则断言不够（会被注释里的同形示例骗过）。
const { originAllowed, isLoopbackHost, isShellOrigin } = require('./security');

module.exports = { createServer, originAllowed, isLoopbackHost, isShellOrigin };
