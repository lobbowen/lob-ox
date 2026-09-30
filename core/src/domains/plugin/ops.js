'use strict';

// 插件域安装/卸载编排 + 已装清单入口（IO 编排）。逐目标串行推进作业：解析 -> 作用域加锁 -> CLI；
// 卸载额外做 bundles 清理 -> scrub -> 重启生效；安装不自动重启。
// listInstalled 解析 targets 后转交 store（不反向依赖）。ctx 经参数显式传入。

const { isProtectedName } = require('./policies');
const store = require('./store');

/** 安装：逐目标串行（加锁 -> CLI add）；不自动重启（用户确认后手动重启）。 */
async function install(ctx, spec, opts) {
  if (!spec) return { ok: false, error: 'missing spec' };
  const r = ctx.resolveTargets(opts && opts.target);
  if (!r.ok) return r; // 目标无效直接报错，不降级到原生
  const job = ctx.jobs.createJob('install', spec, (opts && opts.target) || 'native', r.targets);
  if (ctx.events) ctx.events.append('plugin_install_started', { spec, jobId: job.id, target: job.target });
  let idx = 0;
  const next = () => {
    if (idx >= job.targets.length) {
      const failed = job.targets.filter((t) => t.state === 'failed');
      const ok = failed.length === 0;
      ctx.jobs.finishJob(job, ok, ok ? null : ((failed[0] && failed[0].error) || '部分目标失败'));
      if (ctx.events) {
        if (ok) ctx.events.append('plugin_install_done', { spec, jobId: job.id });
        else ctx.events.append('plugin_install_job_failed', { spec, jobId: job.id, error: (failed[0] && failed[0].error) || '部分目标失败' });
      }
      return;
    }
    const target = r.targets[idx], jt = job.targets[idx];
    jt.state = 'running';
    ctx.jobs.withScopeLock(target.id, async () => {
      let res;
      try { res = await ctx._runCli(target, ['add', spec], { onLine: (l) => { jt.log.push(l); if (jt.log.length > 30) jt.log.shift(); } }); }
      catch (e) { res = { ok: false, error: (e && e.message) || String(e) }; }
      jt.state = res.ok ? 'done' : 'failed';
      jt.error = res.ok ? null : (res.error || '');
      jt.log.push(res.ok ? '完成' : ('失败: ' + (res.error || '')));
      if (ctx.events) ctx.events.append(res.ok ? 'plugin_install_ok' : 'plugin_install_failed', { spec, target: target.name, jobId: job.id, error: res.error });
      // 安装不自动重启（新插件可能不兼容导致实例起不来——由用户确认后手动重启）；
      // 运行中的实例提示重启后可加载，避免「装了却看不到」。
      if (res.ok && ctx._targetRunning(target)) {
        if (target.kind === 'sandbox') jt.log.push('实例运行中：新插件将在实例重启后加载');
        else if (target.kind === 'native') jt.log.push('原生 DSH 运行中：新插件将在重启后加载');
      }
    }).then(() => { idx++; next(); });
  };
  next();
  return { ok: true, jobId: job.id, target: job.target };
}

/** 卸载：逐目标串行（加锁 -> CLI remove -> bundles 清理 -> scrub -> 生效）。 */
async function uninstall(ctx, name, targetStr) {
  if (isProtectedName(name)) return { ok: false, error: '内置组件不可卸载' };
  if (!name) return { ok: false, error: 'missing plugin name' };
  const r = ctx.resolveTargets(targetStr);
  if (!r.ok) return r;
  // 检测：只对实际装有该插件的目标执行卸载（不同实例各自检测）
  const targets = r.targets.filter((t) => ctx.installedOn(t).some((p) => p.name === name));
  if (!targets.length) {
    const desc = targetStr === 'all' ? '任何目标' : ('目标「' + (targetStr || 'native') + '」');
    return { ok: false, error: desc + ' 未安装插件 ' + name };
  }
  const job = ctx.jobs.createJob('uninstall', name, targetStr || 'native', targets);
  if (ctx.events) ctx.events.append('plugin_uninstall_started', { name, jobId: job.id, target: job.target, targets: targets.map((t) => t.name) });
  let idx = 0;
  const next = () => {
    if (idx >= job.targets.length) {
      const failed = job.targets.filter((t) => t.state === 'failed');
      const ok = failed.length === 0;
      ctx.jobs.finishJob(job, ok, ok ? null : ((failed[0] && failed[0].error) || '部分目标失败'));
      if (ctx.events) {
        if (ok) ctx.events.append('plugin_uninstall_done', { name, jobId: job.id });
        else ctx.events.append('plugin_uninstall_job_failed', { name, jobId: job.id, error: (failed[0] && failed[0].error) || '部分目标失败' });
      }
      return;
    }
    const target = targets[idx], jt = job.targets[idx];
    jt.state = 'running';
    ctx.jobs.withScopeLock(target.id, async () => {
      let res;
      try { res = await ctx._runCli(target, ['remove', name], { onLine: (l) => { jt.log.push(l); if (jt.log.length > 30) jt.log.shift(); } }); }
      catch (e) { res = { ok: false, error: (e && e.message) || String(e) }; }
      // bundle 型插件清理：dsh plugin remove 只移除 dependencies，reconcile 对带
      // dsh.bundle 声明的插件会保留在 dsh.profile.bundles，DSH 仍加载；故直接从
      // profile 的 bundles 数组移除，确保卸载彻底生效。
      let bundlesCleaned = false;
      try {
        bundlesCleaned = ctx._removeFromProfileBundles(target, name);
        if (bundlesCleaned) jt.log.push('已从 profile bundles 移除');
      } catch (e) {
        jt.log.push('bundles 清理失败: ' + e.message);
        if (res.ok) res = { ok: false, error: 'bundles 清理失败: ' + e.message };
      }
      // 判定成功：pnpm remove 成功，或 bundles 已清理且 pnpm 报依赖不存在（依赖不在即插件已不装）。
      if (!res.ok && bundlesCleaned && /no such dependency|no dependencies of any kind|CANNOT_REMOVE_MISSING|already removed|not a dependency/i.test(String(res.error || ''))) {
        res = { ok: true, error: null };
        jt.log.push('依赖已清空，bundles 已移除（卸载完成）');
      }
      jt.state = res.ok ? 'done' : 'failed';
      jt.error = res.ok ? null : (res.error || '');
      jt.log.push(res.ok ? '完成' : ('失败: ' + (res.error || '')));
      if (ctx.events) ctx.events.append(res.ok ? 'plugin_uninstall_ok' : 'plugin_uninstall_failed', { name, target: target.name, jobId: job.id, error: res.error });
      // 跨层残留清理/检测：home 补丁层 + 原生 overlay 清理；profile 补丁层只检测报告。
      {
        const scrub = await ctx._scrubPluginLayers(target, name, (m) => jt.log.push(m));
        jt.scrub = scrub;
        if (scrub.warnings.length) jt.log.push('⚠ 残留提示：' + scrub.warnings.join('；'));
      }
      // 运行中的目标不重启会继续按启动清单加载已删插件（client.js 404 ->
      // 浏览器加载失败）；故对实际变更的目标重启，卸载才完整。
      const changed = !!(res.ok || bundlesCleaned);
      if (changed) await ctx._applyPluginChange(target, 'uninstall', (m) => jt.log.push(m));
    }).then(() => { idx++; next(); });
  };
  next();
  return { ok: true, jobId: job.id, target: job.target };
}

/** 已装清单视图：解析 targets 后转交 store（store 不反向 require targets）。 */
async function listInstalled(ctx) {
  const r = ctx.resolveTargets('all');
  const targets = r.ok ? r.targets : [ctx._nativeTarget()];
  return store.listInstalled(ctx, targets);
}

module.exports = { install, uninstall, listInstalled };
