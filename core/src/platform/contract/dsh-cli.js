'use strict';

// 与第三方 dsh CLI 的开关契约（全仓唯一实现）：`dsh web` 会自己拉起系统浏览器，而那条路绕在
// platform/os/browser#openBrowser 唯一出口之外 —— 没有能力档、没有预检、没有三档证据，
// 守卫每次重启就多弹一个窗，且开出去的还是带 ?token= 的本机面板地址。
// 只补缺省：命令里已显式写了 --open 或 --no-open 的一律原样交回，用户的显式意图不被砍掉。

/** 我方组装的 `dsh web` 启动命令一律过此闸；非 web 形态（裸 --version 等）原样交回。 */
function withoutAutoOpen(cmd) {
  const arr = (Array.isArray(cmd) ? cmd : []).map(String);
  const webAt = arr.indexOf('web');
  if (webAt < 0 || arr.includes('--no-open') || arr.includes('--open')) return cmd;
  // 位置参数分隔符之后的 token 不是开关，补在那里等于交给 dsh 当参数。
  const sep = arr.indexOf('--', webAt);
  if (sep < 0) return arr.concat(['--no-open']);
  return arr.slice(0, sep).concat(['--no-open'], arr.slice(sep));
}

module.exports = { withoutAutoOpen };
