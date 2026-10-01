'use strict';

const PROXY_APPS = {
  commandcode: {
    id: 'commandcode',
    name: 'Command Code Proxy',
    pkg: 'commandcode-api-proxy',
    command: ['npx', '--yes', 'commandcode-api-proxy', '--host', '127.0.0.1', '--port', '{{port}}', '--api-key', '{{key}}'],
    healthPath: '/health',
    modelPath: '/v1/models',
    upstream: 'https://api.commandcode.ai',
    // keyEnv 是密钥注入的唯一 env 名（绝不进 cmdline）；其余 env/超时一律不注入，跑上游默认配置。
    keyEnv: 'CC_API_KEY',
    repo: 'thaolaptrinh/commandcode-api-proxy',
    registry: 'commandcode-api-proxy',
    versionRefreshMs: 6 * 3600 * 1000,
    quota: {
      type: 'commandcode-billing',
      apiBase: 'https://api.commandcode.ai',
      creditsPath: '/alpha/billing/credits',
      subscriptionsPath: '/alpha/billing/subscriptions',
      windowMap: { rolling: 'fiveHour', weekly: 'weekly', monthly: null },
      monthlyCapUsd: 10,
    },
    real: true,
  },
};

module.exports = { PROXY_APPS };
