#!/usr/bin/env node
'use strict';

// 远程控制（wan）安全闸：**唯一事实源 + 唯一写入口**，设置面无绕道 —— 公网闸曾只在 setFrp 一处执行，
//   旧设置面 patchDshMain 能开 frpEnabled 却不过闸（可绕过令牌闸开公网暴露）；三态化后唯一写入口是
//   setRemoteMode（lan 同闸口），wan 前置闸 = core.validateWanAccess，patchDshMain 白名单只剩 guardian，frpc 执行边界再复判一次。

const path = require('node:path');
const ROOT = path.join(__dirname, '..');

const results = [];
const check = (n, c, x) => {
  results.push(!!c);
  console.log((c ? 'PASS' : 'FAIL') + ' ' + n + (x !== undefined && x !== '' ? '  <- ' + x : ''));
};

// 行为：注入假 deps 构造 setRemoteMode/setRemoteToken 全链（main 路径），断言闸与落盘次序。
// 每例一份新鲜夹具：写次数账本一旦跨例共享，判据就变成「执行顺序正确」而非「这条动作做对」。
const { createLanActions } = require(path.join(ROOT, 'src', 'app', 'domain-actions', 'lan.js'));
function mk(meta0) {
  const meta = Object.assign({ guardian: false, remoteMode: 'off', remoteToken: '' }, meta0 || {});
  const written = [];
  const eventsSeen = [];
  const evData = [];
  const actions = createLanActions({
    getDaemons: () => ({ enabled: () => false, syncLanState: () => {} }),
    getCtl: () => null, getLifecycleManager: () => null,
    getLan: () => ({ syncProxy: () => Promise.resolve() }),
    getState: () => ({
      readMainMeta: () => ({ ...meta }),
      writeMainMeta: (m) => { Object.assign(meta, m); written.push(m); },
    }),
    getViews: () => ({ dshMain: () => ({ id: 'main' }) }), getInstances: () => null,
    getEvents: () => ({ append: (t, d) => { eventsSeen.push(t); evData.push(d); } }),
    getLogger: () => ({ warn() {} }),
  });
  return { meta, written, eventsSeen, evData, actions };
}

// 开启远程控制即分配令牌：「先去别处设凭据」留在流程里会产出开关已开、无二维码、
// 用户也不知凭据为何的半截状态，所以分配必须与模式同一次落盘完成。
{
  const f = mk();
  const r = f.actions.setRemoteMode('main', 'wan');
  check('W-a 行为：无令牌开 wan -> 自动分配合规令牌、与模式一次落盘（零二次写入）；令牌达闸强度下限且 URL-safe',
    r.ok === true && r.tokenAutoAllocated === true && f.written.length === 1
    && f.written[0].remoteMode === 'wan' && typeof f.written[0].remoteToken === 'string'
    && /^[A-Za-z0-9_-]{8,}$/.test(f.meta.remoteToken) && f.meta.remoteToken === f.written[0].remoteToken,
    JSON.stringify({ r, w: f.written }));
  check('W-h 行为：事件脱敏 —— 自动分配只记布尔，事件载荷零令牌明文',
    f.evData.some((d) => d && d.tokenSet === true && d.autoAllocated === true)
    && !JSON.stringify(f.evData).includes(f.meta.remoteToken), JSON.stringify(f.evData));
}
{
  const f = mk();
  const r = f.actions.setRemoteMode('main', 'lan');
  check('W-b 行为：无令牌开 lan 同样分配（lan 无前置闸，但凭据一次到位才谈得上后面升级 wan）',
    r.ok === true && r.tokenAutoAllocated === true && f.meta.remoteMode === 'lan'
    && /^[A-Za-z0-9_-]{8,}$/.test(f.meta.remoteToken), JSON.stringify(f.written));
}
// 已有令牌（含过弱的历史值）一律不覆盖；被拒必须零写入。
{
  const f = mk({ remoteToken: 'tok' });
  const r = f.actions.setRemoteMode('main', 'wan');
  check('W-c 行为：已有弱令牌开 wan -> 仍被拒（不静默改写用户自设凭据）',
    r.ok === false && f.written.length === 0 && f.meta.remoteToken === 'tok', JSON.stringify({ r, m: f.meta }));
}
{
  const f = mk({ remoteToken: 'remote-tok-0123' });
  const r = f.actions.setRemoteMode('main', 'wan');
  check('W-d 行为：合规令牌已设 -> wan 放行、不重复分配也不回写令牌字段',
    r.ok === true && r.tokenAutoAllocated === false && f.meta.remoteMode === 'wan'
    && f.meta.remoteToken === 'remote-tok-0123' && f.written[0].remoteToken === undefined,
    JSON.stringify({ r, w: f.written }));
}
{
  // 夹具从 off 起步且无令牌：同时咬住「off 不过闸也不凭空补凭据」（与现值同则不落盘）与
  //   「off 改模式时只写模式字段」——起点若给成 lan|wan，落盘就是应有动作。
  const f = mk({ remoteMode: 'off', remoteToken: '' });
  const off = f.actions.setRemoteMode('main', 'off');
  const f2 = mk({ remoteMode: 'wan', remoteToken: 'remote-tok-0123' });
  const off2 = f2.actions.setRemoteMode('main', 'off');
  check('W-e 行为：off 是安全方向 —— 不过闸不分配、与现值同则不重复落盘；改模式时只写模式字段',
    off.ok === true && off.tokenAutoAllocated === false && f.written.length === 0
    && !String(f.meta.remoteToken).trim()
    && off2.ok === true && f2.written.length === 1 && f2.written[0].remoteToken === undefined,
    JSON.stringify({ r: off, w: f.written, w2: f2.written }));
}
// mode/token 必须显式给出 —— 漏字段请求不得被缺省成 'off'/清除（静默关远程控制/清凭据）。
{
  const f = mk();
  const noMode = f.actions.setRemoteMode('main');
  const f2 = mk();
  const bogusMode = f2.actions.setRemoteMode('main', 'WAN');
  const f3 = mk();
  const noTok = f3.actions.setRemoteToken('main');
  check('W-f 行为：缺 mode（不再隐式归 off）/ 非法 mode（大小写不符，不做归一）/ 缺 token（不当作清除）一律拒且零写入',
    noMode && noMode.ok === false && f.written.length === 0
    && bogusMode && bogusMode.ok === false && f2.written.length === 0
    && noTok && noTok.ok === false && f3.written.length === 0,
    JSON.stringify([noMode, bogusMode, noTok]));
  const f4 = mk({ remoteToken: 'remote-tok-0123' });
  const clr = f4.actions.setRemoteToken('main', '');
  check('W-g 行为：空串仍是显式清除（ok 且落盘 remoteToken=""）',
    clr && clr.ok === true && f4.meta.remoteToken === '' && f4.written.length === 1, JSON.stringify(f4.written));
  const f5 = mk();
  const wBefore = f5.written.length;
  const weak = f5.actions.setRemoteToken('main', 'tok');
  check('W-c 行为：4 位令牌写 main -> 写入口即拒（ok:false、零落盘）',
    weak && weak.ok === false && f5.written.length === wBefore, JSON.stringify(weak));
  const f6 = mk();
  const good = f6.actions.setRemoteToken('main', 'remote-tok-0123');
  check('W-d 行为：合规令牌写入通过（写入口 ok:true 且落盘）',
    good && good.ok === true && f6.meta.remoteToken === 'remote-tok-0123', JSON.stringify(good));
  check('W-h 行为：事件脱敏 —— 显式设置同样零令牌明文',
    !JSON.stringify(f6.evData).includes('remote-tok-0123'), JSON.stringify(f6.evData));
}

const failed = results.filter((r) => !r);
console.log('\n结果: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
process.exit(failed.length ? 1 : 0);
