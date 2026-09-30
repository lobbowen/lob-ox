'use strict';

// 反向代理应用注册表：每个反代产品 = 一个独立完整的第三方开源「应用」，我们只对接
// （安装/启停/探活/转发/配额感知/更新检测），绝不 fork 或二改。新增产品加一条定义即可；
// 产品内不内置测试供应商（测试自行注册 mock 应用）。

const PROXY_APPS = {
  commandcode: {
    id: 'commandcode',
    name: 'Command Code Proxy',
    pkg: 'commandcode-api-proxy',
    command: ['npx', '--yes', 'commandcode-api-proxy', '--host', '127.0.0.1', '--port', '{{port}}', '--api-key', '{{key}}'],
    healthPath: '/health',
    modelPath: '/v1/models',
    upstream: 'https://api.commandcode.ai',
    // 实例环境契约：keyEnv 是密钥注入的唯一 env 名（绝不进 cmdline）；app.env/超时等一律不注入，
    // 跑上游完全默认配置（作者设计值）——自我干预（如 CC_IDLE_TIMEOUT_MS=0）曾导致回归，保持纯净注入。
    keyEnv: 'CC_API_KEY',
    repo: 'thaolaptrinh/commandcode-api-proxy',
    // 自动更新：最新版本从 npm registry 查（同一 package 名）。空则跳过版本检查。
    registry: 'commandcode-api-proxy',
    versionRefreshMs: 6 * 3600 * 1000,
    // 每账号配额来源：官方 billing 面（解析逻辑见 quota-strategies.js detectCommandCodeBilling）。
    // windowMap 指 rolling/weekly 字段；monthly 由订阅面推导。
    quota: {
      type: 'commandcode-billing',
      apiBase: 'https://api.commandcode.ai',
      creditsPath: '/alpha/billing/credits',
      subscriptionsPath: '/alpha/billing/subscriptions',
      windowMap: { rolling: 'fiveHour', weekly: 'weekly', monthly: null },
      // 月度配额上限（$/月）：订阅含 $10/月总池，周窗口从池内扣（weekly.used + monthlyRemaining = 10），
      // 解析层据此推导 monthly.percent。
      monthlyCapUsd: 10,
    },
    real: true,
  },
};

module.exports = { PROXY_APPS };
