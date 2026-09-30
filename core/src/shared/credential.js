'use strict';

// 凭据强度判定（L0 纯函数：零 require、零 IO、零平台分支、零域知识）。
// 放 shared 而非 relay 域：强度下限同时被 relay 暴露闸、实例域写入口、app 侧 patchDshMain
// 三个消费点跨两个域 + 编排层使用，放进任一域都会逼出跨域边（DS-G1 判红）。单一事实源在此。

/** 远程访问令牌强度闸，与 apiAccessKey 的「至少 8 位」门（app/settings/access.js）同规：
 *  remoteToken 守护经 frp 暴露到公网的 DSH 特权面（relay 空 token 恒放行），1~2 位等同无令牌，
 *  故只判非空白不够。落点由调用方负责；reason 取值 ''（合格）| 'empty' | 'short'。 */
function remoteTokenStrength(token) {
  const t = String(token == null ? '' : token).trim();
  if (!t) return { ok: false, reason: 'empty' };
  if (t.length < 8) return { ok: false, reason: 'short' };
  return { ok: true, reason: '' };
}

module.exports = { remoteTokenStrength };
