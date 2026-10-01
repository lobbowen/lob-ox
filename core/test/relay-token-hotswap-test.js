#!/usr/bin/env node
'use strict';

// relay 门卫令牌必须**可热换**：syncProxy 的「已存在则 return」快路径不重读 remoteToken、applyToken 只处理
//   dshToken ⇒ 令牌闸已放行而 relay 进程内 token 仍是空串（tokenGate 恒放行，门卫形同不存在）。
//   H-a 弱令牌即拒且不留半改 · H-b 只换令牌即触发 onRemoteChange · H-c 同值幂等不触发 · H-d 清空同样触发 · H-e 真实 relay 的 hasToken 三态。

const path = require('node:path');
const ROOT = path.join(__dirname, '..');

const results = [];
const check = (n, c, x) => {
  results.push(!!c);
  console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  <- ' + x : ''));
};

// 行为：真实 createOps 断言「只改令牌」一条链走通
const { createOps } = require(path.join(ROOT, 'src', 'domains', 'instance', 'ops.js'));
const seen = [];
const it2 = { id: 'i1', name: 'n', port: 29051, guardian: true, remoteMode: 'lan', remoteToken: 'tok-a-01234567' };
const ops2 = createOps({
  store: { instances: [it2], save() {} },
  logger: { warn() {} },
  events: { append(t) { seen.push(t); } },
  hooks: { onRemoteChange(i) { seen.push('sync:' + i.remoteToken); } },
});

// 弱令牌写入口即拒，且**不改任何字段**（半改状态防线）
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

// 行为：真实 createRelay，断言 setToken 后门卫生效（空令牌 = 闸恒放行）
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
