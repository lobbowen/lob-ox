'use strict';

const { cookieByName } = require('./core');
const { bootstrapDshCookie } = require('../../platform/service/token/exchange');

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

  let dshCookie = null;
  let bootstrapping = null;
  let bootstrapEpoch = 0;
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

  function startBootstrap(dshToken, via) {
    const myEpoch = bootstrapEpoch;
    let pr;
    pr = bootstrapDshCookie(targetHost, targetPort, dshToken).then((c) => {
      if (bootstrapping === pr) bootstrapping = null;
      if (myEpoch !== bootstrapEpoch) return null;
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

  function refreshDshSession() {
    const dshToken = dshTokenOf() || '';
    bootstrapEpoch += 1;
    state.tokenSet = !!dshToken;
    dshCookie = null;
    state.cookieReady = false;
    bootstrapping = null;
    if (dshToken) startBootstrap(dshToken, 'refresh');
  }

  function ensureDshCookie() {
    if (dshCookie) return Promise.resolve(dshCookie);
    const dshToken = dshTokenOf() || '';
    state.tokenSet = !!dshToken;
    if (!dshToken) return Promise.resolve(null);
    return bootstrapping || startBootstrap(dshToken, 'lazy');
  }

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
