'use strict';

// DSH 浏览器会话桥（IO 层）：按需从令牌池取 dshToken，换取 dsh-auth-* cookie，注入 HTTP/WS；
// 上游 401/403 时清 cookie 自愈。TK-4：令牌池是唯一存储，本模块只保留派生 cookie 与在途 Promise，
// 不复制令牌真值（dshToken 初值仅为旧调用方兼容路径，真值一律经 dshTokenOf 按需读）。

const { cookieByName } = require('./core');
// 换取 dsh-auth cookie 的协议实现只在 platform/service/token/exchange 一份。
const { bootstrapDshCookie } = require('../../platform/service/token/exchange');

/** 构造会话桥。
 *  opts: targetHost/targetPort（回环 DSH 目标）、id/logger/events（诊断与事件）、
 *  dshTokenOf（令牌按需读取函数，TK-4）、dshToken（启动令牌初值，兼容旧调用方）。
 */
function createSession(opts) {
  const o = opts || {};
  const targetHost = o.targetHost;
  const targetPort = o.targetPort;
  const logger = o.logger || null;
  const log = (lv, msg) => { if (logger && logger[lv]) { try { logger[lv]('[relay] ' + msg); } catch {} } };
  const relayId = o.id || '';
  const events = o.events || null;
  const emit = (type, data) => { try { if (events && events.append) events.append(type, Object.assign({ id: relayId }, data || {})); } catch {} };
  const dshTokenOf = typeof o.dshTokenOf === 'function'
    ? o.dshTokenOf
    : (() => o.dshToken || '');

  let dshCookie = null; // "name=value"（dsh-auth-*）——派生结果，非令牌本身
  let bootstrapping = null; // 进行中的换取 Promise（防并发重复换取）
  let bootstrapEpoch = 0; // 令牌换代序号：refresh 后旧代在途换取的结果必须丢弃，不得覆盖新 cookie
  // 注入状态（可诊断层）：经 status() 暴露，LAN 面板据此显示「远程就绪/正在注入/令牌缺失」。
  const state = { tokenSet: !!dshTokenOf(), cookieReady: false, lastAttemptAt: null, lastOkAt: null, lastError: null, lastErrorAt: null };

  function recordOk(c) {
    state.lastAttemptAt = Date.now();
    if (c) { state.cookieReady = true; state.lastOkAt = Date.now(); state.lastError = null; }
    else { state.cookieReady = false; if (!state.lastError) state.lastError = '令牌换取 cookie 未返回（DSH 无认证/未就绪/令牌过期）'; state.lastErrorAt = Date.now(); }
  }
  function recordFail(why) {
    state.lastAttemptAt = Date.now();
    state.cookieReady = false;
    if (!state.lastError || state.lastErrorAt === null || Date.now() - state.lastErrorAt > 30000) {
      state.lastError = why;
      state.lastErrorAt = Date.now();
    }
    emit('lan_cookie_failed', { error: why });
  }
  function recordReady(c, via) {
    recordOk(c);
    if (c) {
      emit('lan_cookie_exchanged', { via: via || 'refresh' });
      log('info', 'DSH 浏览器会话 cookie 已换取' + (via ? '(' + via + ')' : '') + ' (' + c.split('=')[0] + ')');
    } else {
      log('warn', 'DSH 令牌换取 cookie 失败（可能是旧版无认证或令牌过期）');
    }
  }

  /** 发起一次换取；结果仅在仍是当前代时落进派生状态（旧代迟到即丢弃）。 */
  function startBootstrap(dshToken, via) {
    const myEpoch = bootstrapEpoch;
    let pr;
    pr = bootstrapDshCookie(targetHost, targetPort, dshToken).then((c) => {
      if (bootstrapping === pr) bootstrapping = null;
      if (myEpoch !== bootstrapEpoch) return null; // 期间已 refresh：旧 cookie 不得覆盖新值
      dshCookie = c;
      recordReady(c, via);
      return c;
    }).catch((e) => {
      if (bootstrapping === pr) bootstrapping = null;
      if (myEpoch === bootstrapEpoch) recordFail('令牌换取异常: ' + (e && e.message));
      return null;
    });
    bootstrapping = pr;
    return pr;
  }

  /** 令牌变化时重置并重新换取 cookie（TK-4：值始终由 dshTokenOf() 按需读取）。 */
  function refreshDshSession() {
    const dshToken = dshTokenOf() || '';
    bootstrapEpoch += 1; // 换代：在途的旧代换取结果作废
    state.tokenSet = !!dshToken;
    dshCookie = null;
    state.cookieReady = false;
    bootstrapping = null;
    if (dshToken) startBootstrap(dshToken, 'refresh');
  }

  /** 确保已持有 DSH cookie；未持有且令牌池有令牌时尝试换取（懒加载，幂等）。 */
  function ensureDshCookie() {
    if (dshCookie) return Promise.resolve(dshCookie);
    const dshToken = dshTokenOf() || '';
    state.tokenSet = !!dshToken;
    if (!dshToken) return Promise.resolve(null);
    return bootstrapping || startBootstrap(dshToken, 'lazy');
  }

  /** 把 DSH cookie 合并进客户端 Cookie 串：同名则保留客户端值（避免重复段）。纯拼接，无 IO。 */
  function mergeDshCookie(cookie, dshC) {
    let out = cookie || '';
    if (dshC) {
      const name = dshC.split('=')[0];
      if (cookieByName(out, name) === null) out = out ? out + '; ' + dshC : dshC;
    }
    return out;
  }

  async function mergedCookieHeaders(reqHeaders) {
    const dshC = await ensureDshCookie();
    return mergeDshCookie((reqHeaders && reqHeaders.cookie) || '', dshC);
  }

  /** 上游 401/403：清派生 cookie，使下次请求以 dshToken 重新换取（会话自愈）。 */
  function invalidate(statusCode) {
    if (!dshCookie) return false;
    dshCookie = null;
    state.cookieReady = false;
    state.lastError = '上游 ' + statusCode + '：cookie 已清，下次请求用令牌重换';
    state.lastErrorAt = Date.now();
    log('warn', '上游 ' + statusCode + '，清 DSH cookie 下次请求重换');
    emit('lan_cookie_invalidated', { status: statusCode });
    return true;
  }

  /** 当前派生 cookie（tunnel 的降级路径用）。 */
  function currentCookie() { return dshCookie; }
  function hasToken() { return !!dshTokenOf(); }
  function status() { return { ...state }; }

  return {
    ensureDshCookie,
    refreshDshSession,
    mergedCookieHeaders,
    mergeDshCookie,
    invalidate,
    currentCookie,
    hasToken,
    status,
  };
}

module.exports = { createSession };
