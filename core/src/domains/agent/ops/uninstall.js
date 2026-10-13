'use strict';

// agent 卸载（五件套之四）。
//
// 从 app/native/ops.js 的 uninstall 收拢。核心不变量是**越界保护**：
// 只删产品自己的数据，绝不碰其他产品（含 DSH）的用户数据。
// 这条在原实现里由 _withinAncestor + safeAncestors 保证，收拢时原样保留，
// 并把「祖先集合从哪来」显式化——那是安全边界，不能隐式依赖 host 字段。

const fs = require('node:fs');
const path = require('node:path');

const status = require('../status');

/**
 * 目标路径是否落在某个祖先目录内。
 * 用 realpath 归一化后比较——防止符号链接与 .. 穿越绕过。
 * 与原实现同一口径：realpath 失败时退化为 resolve（路径不存在时也要能判）。
 */
function withinAncestor(target, ancestors) {
  if (!target || !Array.isArray(ancestors)) return false;
  let rp;
  try { rp = fs.realpathSync(target); } catch { rp = path.resolve(target); }
  for (const a of ancestors) {
    if (!a) continue;
    let ra;
    try { ra = fs.realpathSync(a); } catch { ra = path.resolve(a); }
    if (rp === ra) return true;
    if (rp.startsWith(ra.endsWith(path.sep) ? ra : ra + path.sep)) return true;
  }
  return false;
}

/**
 * 卸载一个 agent。
 *
 * @param {object} env
 * @param {string[]} env.safeAncestors  允许删除的根集合（安全边界，必填）
 * @param {string[]} [env.extraPaths]   额外要删的路径（manifest.dataPaths 等）
 * @param {Function} [env.runNpm]       npm 卸载执行器 { action:'uninstall', pkg, prefix }
 * @param {string} [env.pkg]            包名
 * @param {string} [env.prefix]         安装前缀
 * @param {Function} [env.isActive]     进程是否在跑
 * @param {Function} [env.stop]         停进程
 * @param {object} [env.events]         事件账本
 * @param {Function} [env.log]          日志
 * @param {object} [env.state]          可变状态（用于 busy 判定）
 * @param {object} [env.tasks]          任务注册表
 * @returns {Promise<{ok:boolean,removed:string[],error:string|null}>}
 */
async function uninstall(env, cfg) {
  const e = env || {};
  const c = cfg || {};
  const log = (m) => { if (e.log) { try { e.log(m); } catch {  } } };
  const ev = (t, d) => { if (e.events) { try { e.events.append(t, d || {}); } catch {  } } };

  // ---- 前置校验：安全边界必填，缺它就不许删 ----
  const ancestors = Array.isArray(e.safeAncestors) ? e.safeAncestors.filter(Boolean) : [];
  if (ancestors.length === 0) {
    return { ok: false, removed: [], error: '拒绝卸载：未提供 safeAncestors（安全边界不可缺省）' };
  }

  // ---- busy 判定（与 install/upgrade 同一套互斥）----
  const gate = status.assertNotBusy(e.state || {}, 'uninstall');
  if (gate) return { ok: false, removed: [], error: gate.error };

  if (e.state) e.state.uninstalling = true;
  ev('agent_uninstall_started', {});

  const removed = [];
  const rm = (p) => {
    if (!p) return;
    if (!withinAncestor(p, ancestors)) {
      // 越界即跳过并留痕——这是本模块唯一不容妥协的规则。
      log('uninstall 跳过越界路径（不在产品数据根内）: ' + p);
      return;
    }
    try { fs.rmSync(p, { recursive: true, force: true }); removed.push(p); }
    catch (e2) { log('uninstall 清理失败: ' + p + ' - ' + ((e2 && e2.message) || e2)); }
  };

  try {
    // ---- 先停进程 ----
    if (e.isActive && e.isActive()) {
      log('停止运行中的 agent…');
      if (e.stop) await e.stop();
    }

    // ---- npm 卸载（由调用方提供执行器；不直接依赖 dist，保持可测）----
    if (e.runNpm && e.pkg) {
      const res = await e.runNpm({ action: 'uninstall', pkg: e.pkg, prefix: e.prefix || null });
      if (!res || res.ok !== true) {
        // npm 卸载失败不阻断后续清理：包目录可能已被部分删除，
        // 而进程已停、数据待清。原实现同样继续。
        log('npm 卸载返回非成功（继续清理本地数据）: ' + ((res && res.error) || '未知'));
      }
    }

    // ---- 清理额外路径（manifest 记录的 dataPaths 等）----
    for (const p of (e.extraPaths || [])) rm(p);

    // ---- 清理安装前缀自身（若在边界内）----
    if (e.prefix) rm(e.prefix);

    if (e.state) { e.state.uninstalling = null; }
    ev('agent_uninstalled', { removed: removed.length });
    log('卸载完成，清理 ' + removed.length + ' 个路径');
    return { ok: true, removed, error: null };
  } catch (err) {
    if (e.state) e.state.uninstalling = null;
    const msg = (err && err.message) || String(err);
    ev('agent_uninstall_failed', { error: msg });
    log('卸载异常: ' + msg);
    return { ok: false, removed, error: msg };
  }
}

module.exports = { uninstall, withinAncestor };
