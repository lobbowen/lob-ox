#!/usr/bin/env node
'use strict';

// syncProxy 的「已存在则 return」快路径不重读 remoteToken ⇒ 令牌闸已放行而 relay 进程内 token 仍是空串（门卫形同不存在）。

const path = require('node:path');
const ROOT = path.join(__dirname, '..');

const results = [];
const check = (n, c, x) => {
  results.push(!!c);
  console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  <- ' + x : ''));
};

const { createOps } = require(path.join(ROOT, 'src', 'domains', 'instance', 'ops.js'));
const seen = [];
const it2 = { id: 'i1', name: 'n', port: 29051, guardian: true, remoteMode: 'lan', remoteToken: 'tok-a-01234567' };
const ops2 = createOps({
  store: { instances: [it2], save() {} },
  logger: { warn() {} },
  events: { append(t) { seen.push(t); } },
  hooks: { onRemoteChange(i) { seen.push('sync:' + i.remoteToken); } },
});

{
  const before = it2.guardian;
  const r = ops2.updateInstance('i1', { guardian: false, remoteToken: 'B' });
  check('H-a 行为：updateInstance 拒 1 位令牌（ok:false）且同补丁其它字段未被改',
    r.ok === false && it2.remoteToken === 'tok-a-01234567' && it2.guardian === before, JSON.stringify(r));
}

ops2.updateInstance('i1', { remoteToken: 'tok-b-01234567' });
check('H-b 行为：只换令牌（开关不变）即触发 onRemoteChange 且钩子读得到新值（变更留痕事件同源，事件名不单独绑定）',
  seen.includes('sync:tok-b-01234567'), seen.join(','));
seen.length = 0;
ops2.updateInstance('i1', { remoteToken: 'tok-b-01234567' });
check('H-c 行为：同值幂等写不再触发钩子/事件（防空转刷屏）',
  !seen.some((x) => x === 'inst_remote_token_changed' || String(x).startsWith('sync:')), seen.join(','));
ops2.updateInstance('i1', { remoteToken: '' });
check('H-d 行为：清空令牌同样触发（暴露闸与隧道必须收到清空信号）', seen.includes('sync:'), seen.join(','));

const { createRelay } = require(path.join(ROOT, 'src', 'domains', 'relay', 'index.js'));
const srv = createRelay('127.0.0.1', 9, { token: '', logger: null });
const seq = [srv.hasToken()];
srv.setToken('newtok'); seq.push(srv.hasToken());
srv.setToken(''); seq.push(srv.hasToken());
check('H-e 行为：空令牌 hasToken()=false（tokenGate 会恒放行）-> setToken 后 true（门卫开始生效）-> 清空后 false',
  JSON.stringify(seq) === '[false,true,false]', JSON.stringify(seq));

const failed = results.filter((r) => !r);
console.log('\n结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
process.exit(failed.length ? 1 : 0);
