'use strict';

// 入站文本的机密脱敏（与业务无关，供各采集/读取口复用）。脱敏是边界动作：两条入站路径各自定义
//   「什么算机密」等于漏一处就把凭据投给人看的界面与快照。
// 调用方一律在入站处调用一次，别让未脱敏的原文继续往下走（进台账、进快照、进 HTTP 都算泄漏面）。

/** 代理地址里的凭据抹除：`user:pass@host` 没有理由出现在快照、表单或界面上（快照 0600 也要给人看）。
 *  两种写法都要管（`http://u:p@host` 与裸 `u:p@host`）。`//` 必须先于「无协议头」这条分支参与匹配，
 *  且用户名与密码都不得跨 `/`：否则 `http://u:p@h` 会把整段 `//u:p` 当成密码吃掉、留下 `http:***@h`。 */
function maskProxyServer(server) {
  return server ? String(server).replace(/(\/\/)?([^\s/@:]+):([^\s/@]*)@/, '$1$2:***@') : null;
}

/** 整行文本里的凭据抹除（探测留痕、失败原因都可能带地址）：可能有多处，故 global。 */
function maskProxySecrets(text) {
  return String(text == null ? '' : text).replace(/(\/\/)?([^\s/@:]+):([^\s/@]*)@/g, '$1$2:***@');
}

module.exports = { maskProxyServer, maskProxySecrets };
