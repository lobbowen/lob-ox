'use strict';

const kinds = require('../../platform/service/token/kinds');
const pool = require('../../platform/service/token/pool');

const KINDS = {
  'dsh-main': {
    side: 'dsh',
    strategy: 'capture+persist',
    persistent: true,
    captured: true,
    store: 'pool-file',
    unitBacked: false,
    desc: '原生 main 会话令牌（DSH 进程生成；捕捉+持久化+跟随）',
  },
  'dsh-instance': {
    side: 'dsh',
    strategy: 'capture+persist',
    persistent: true,
    captured: true,
    store: 'pool-file',
    unitBacked: true,
    desc: '沙箱实例会话令牌（DSH 进程生成；源为 dsh-web@<id> 单元）',
  },
  'dsh-auth': {
    side: 'dsh-derived',
    strategy: 'exchange',
    persistent: false,
    captured: false,
    store: 'memory',
    unitBacked: false,
    desc: '浏览器会话 cookie（dsh-auth-*，由 dsh-main/dsh-instance 换取；只存进程内存）',
  },
  'remote-token': {
    side: 'user',
    strategy: 'config',
    persistent: false,
    captured: false,
    store: 'config',
    unitBacked: false,
    desc: '远程/局域网门卫令牌（用户在 UI 填写）',
  },
  'api-access-key': {
    side: 'user',
    strategy: 'config',
    persistent: false,
    captured: false,
    store: 'config',
    unitBacked: false,
    desc: '出回环访问密钥（用户 config 填写）',
  },
  'frp-auth': {
    side: 'user',
    strategy: 'config',
    persistent: false,
    captured: false,
    store: 'config',
    unitBacked: false,
    desc: 'FRP 认证令牌（用户在 UI 填写，透传给 frpc）',
  },
  'lan-gate': {
    side: 'self',
    strategy: 'issue+verify',
    persistent: false,
    captured: false,
    store: 'browser',
    unitBacked: false,
    desc: 'lan gate cookie（lobox_lan_token，我方签发并校验）',
  },
};

const KIND_INFERENCE = {
  byId: { main: 'dsh-main' },
  unitPrefix: [['dsh-web@', 'dsh-instance']],
  unitKind: 'dsh-instance',
  fileKind: 'dsh-main',
};

const TOKEN_FILE_NAME = 'dsh-main-token.log';

kinds.setKinds(KINDS);
pool.configureKindInference(KIND_INFERENCE);

module.exports = { KINDS, TOKEN_FILE_NAME };
